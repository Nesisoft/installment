import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@installment/db';
import { ScheduleGenerator, type GeneratedSchedule } from './schedule-generator';
import { PlanTemplateNotFoundError } from '../plans/errors';

const pt = schema.plan_templates;

export const planQuoteSchema = z.object({
  amount_pesewas: z.number().int().positive(),
  /** Quote one named template, or omit for every template the amount qualifies for. */
  plan_template_id: z.string().uuid().optional(),
  /** Restrict to the templates a product actually offers. */
  plan_template_ids: z.array(z.string().uuid()).max(50).optional(),
});
export type PlanQuoteInput = z.infer<typeof planQuoteSchema>;

export interface QuotedInstallment {
  sequence_number: number;
  kind: 'down_payment' | 'installment';
  amount_pesewas: number;
  due_date: string;
  grace_until_date: string;
}

export interface PlanQuote {
  plan_template_id: string;
  name: string;
  description: string | null;
  business_model: string;
  /** Excludes the deposit — the engine's own definition. */
  number_of_installments: number;
  installment_frequency_days: number;
  grace_period_days: number;
  down_payment_bps: number;
  interest_rate_bps: number;
  service_fee_flat_pesewas: number;
  late_fee_bps_per_week: number;
  late_fee_cap_bps: number;
  min_amount_pesewas: number;
  max_amount_pesewas: number;
  down_payment_pesewas: number;
  financed_amount_pesewas: number;
  total_interest_pesewas: number;
  total_fees_pesewas: number;
  total_payable_pesewas: number;
  /** What each financed instalment costs, for the "or GHS X/week" line. */
  per_installment_pesewas: number;
  /**
   * Rows the customer will actually be billed — the deposit first when there is
   * one, so `length` is the number the UI counts ("instalment 2 of 4").
   */
  installments: QuotedInstallment[];
  eligible: boolean;
  ineligible_reason: string | null;
}

/**
 * What an instalment plan would cost, before any plan exists.
 *
 * The product, cart and checkout screens all show a full schedule up front, and
 * the numbers have to be the ones the engine will actually create — a preview
 * that is a pesewa out is a preview that argues with the contract. So this runs
 * `ScheduleGenerator`, the same class `CustomerPlansService.activateFromApplication`
 * runs, rather than reimplementing the arithmetic client-side. There is
 * deliberately no second implementation anywhere to drift from this one.
 *
 * A quote is an estimate in one respect only: the start date. It anchors on
 * today, and the real schedule anchors on the day the plan activates.
 */
export class PlanQuoteService {
  constructor(
    private readonly db: Database,
    private readonly generator: ScheduleGenerator = new ScheduleGenerator(),
  ) {}

  async quote(rawInput: unknown, now: Date = new Date()): Promise<PlanQuote[]> {
    const input: PlanQuoteInput = planQuoteSchema.parse(rawInput);

    const where = [
      eq(pt.is_active, true),
      lte(pt.effective_from, now.toISOString()),
      or(isNull(pt.effective_to), gte(pt.effective_to, now.toISOString())),
    ];
    if (input.plan_template_id) where.push(eq(pt.id, input.plan_template_id));
    if (input.plan_template_ids?.length) {
      where.push(sql`${pt.id} = ANY(${input.plan_template_ids})`);
    }

    const templates = await this.db
      .select()
      .from(pt)
      .where(and(...where))
      .orderBy(pt.number_of_installments);

    if (input.plan_template_id && templates.length === 0) {
      throw new PlanTemplateNotFoundError(input.plan_template_id);
    }

    return templates.map((t) => this.quoteOne(t, input.amount_pesewas, now));
  }

  private quoteOne(
    t: typeof schema.plan_templates.$inferSelect,
    amountPesewas: number,
    now: Date,
  ): PlanQuote {
    const belowMin = amountPesewas < t.min_amount_pesewas;
    const aboveMax = amountPesewas > t.max_amount_pesewas;

    let generated: GeneratedSchedule | null = null;
    let reason: string | null = belowMin
      ? `This plan starts at ${formatGhs(t.min_amount_pesewas)}`
      : aboveMax
        ? `This plan covers up to ${formatGhs(t.max_amount_pesewas)}`
        : null;

    if (!reason) {
      try {
        generated = this.generator.generate({
          businessModel: t.business_model as 'bnpl',
          orderAmountPesewas: amountPesewas,
          downPaymentBps: t.down_payment_bps,
          interestRateBps: t.interest_rate_bps,
          serviceFeeFlatPesewas: t.service_fee_flat_pesewas,
          numberOfInstallments: t.number_of_installments,
          installmentFrequencyDays: t.installment_frequency_days,
          gracePeriodDays: t.grace_period_days,
          startDate: now,
        });
      } catch (err) {
        // The generator's own guards (amount too small to split N ways, and
        // friends). Surfacing the reason beats a 500 on a browse screen.
        reason = err instanceof Error ? err.message : 'This plan is not available for this amount';
      }
    }

    const financed = generated?.installments.filter((i) => i.kind === 'installment') ?? [];

    return {
      plan_template_id: t.id,
      name: t.name,
      description: t.description,
      business_model: t.business_model,
      number_of_installments: t.number_of_installments,
      installment_frequency_days: t.installment_frequency_days,
      grace_period_days: t.grace_period_days,
      down_payment_bps: t.down_payment_bps,
      interest_rate_bps: t.interest_rate_bps,
      service_fee_flat_pesewas: t.service_fee_flat_pesewas,
      late_fee_bps_per_week: t.late_fee_bps_per_week,
      late_fee_cap_bps: t.late_fee_cap_bps,
      min_amount_pesewas: t.min_amount_pesewas,
      max_amount_pesewas: t.max_amount_pesewas,
      down_payment_pesewas: generated?.downPaymentPesewas ?? 0,
      financed_amount_pesewas: generated?.financedAmountPesewas ?? 0,
      total_interest_pesewas: generated?.totalInterestPesewas ?? 0,
      total_fees_pesewas: generated?.totalFeesPesewas ?? 0,
      total_payable_pesewas: generated?.totalPayablePesewas ?? 0,
      // The rows are not all equal — the rounding remainder lands a pesewa at a
      // time on the earliest ones — so the headline figure is the largest, which
      // is what the customer will actually be asked for first.
      per_installment_pesewas: financed.length
        ? Math.max(...financed.map((i) => i.amountDuePesewas))
        : 0,
      installments: (generated?.installments ?? []).map((i) => ({
        sequence_number: i.sequenceNumber,
        kind: i.kind,
        amount_pesewas: i.amountDuePesewas,
        due_date: i.dueDate,
        grace_until_date: i.graceUntilDate,
      })),
      eligible: generated !== null,
      ineligible_reason: reason,
    };
  }
}

function formatGhs(pesewas: number): string {
  return `GHS ${(pesewas / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
