import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from '../settlements/payout-recorder';
import { ReserveReleaseService } from '../settlements/reserve-release.service';
import { DefaultService } from '../settlements/default.service';
import { CustomerPlansService } from './customer-plans.service';
import { PlanCashLedger } from './plan-cash-ledger';
import { InstallmentRefundDueDateInPastError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Refunds on plans that carry interest, re-collected rows, and the reserve and
 * default bookkeeping around them — wired as production wires it (cash ledger,
 * reserves, defaults), because every one of these was a disagreement between
 * those pieces.
 */
describe.skipIf(!RUN_DB)('Refund shares and re-collects (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const defaults = new DefaultService(db, ledger, reserves);
  const cashLedger = new PlanCashLedger(ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(
    db,
    audit,
    undefined,
    payouts,
    reserves,
    defaults,
    cashLedger,
  );
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const templates: Record<string, string> = {};

  beforeAll(async () => {
    const suffix = randomUUID();
    const make = async (key: string, input: Parameters<PlanTemplatesService['create']>[0]) => {
      templates[key] = (await planTemplates.create(input, ACTOR)).id;
    };
    const range = { min_amount_pesewas: 1_000, max_amount_pesewas: 10_000_000 };
    // 100,000 → deposit 20,000, then 88,000 (80,000 financed + 8,000 interest)
    // as 29,334 / 29,333 / 29,333.
    await make('bnplInterest', {
      name: `BNPL-int ${suffix}`,
      business_model: 'bnpl',
      number_of_installments: 3,
      installment_frequency_days: 30,
      down_payment_bps: 2_000,
      interest_rate_bps: 1_000,
      ...range,
    });
    // The seeded "Pay in 6": 30% deposit and five payments, no interest.
    await make('payIn6', {
      name: `Pay-in-6 ${suffix}`,
      business_model: 'bnpl',
      number_of_installments: 5,
      installment_frequency_days: 14,
      down_payment_bps: 3_000,
      ...range,
    });
    // 100,000 + 30% interest over twelve: 10,834 × 4, then 10,833 × 8.
    await make('rtoInterest', {
      name: `RTO-int ${suffix}`,
      business_model: 'rent_to_own',
      number_of_installments: 12,
      installment_frequency_days: 30,
      interest_rate_bps: 3_000,
      ...range,
    });
    await make('hybrid', {
      name: `Hybrid-shr ${suffix}`,
      business_model: 'hybrid',
      number_of_installments: 3,
      installment_frequency_days: 30,
      down_payment_bps: 4_000,
      ...range,
    });
    await make('layaway', {
      name: `Layaway-shr ${suffix}`,
      business_model: 'layaway',
      number_of_installments: 4,
      installment_frequency_days: 7,
      ...range,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function activate(template: string, order = 100_000) {
    const suffix = randomUUID();
    const merchantId = (
      await merchants.create(
        {
          business_name: `M ${suffix}`,
          legal_name: `M Ltd ${suffix}`,
          email: `m+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    const customerId = (
      await customers.register(
        {
          first_name: 'Share',
          last_name: 'Test',
          email: `s+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templates[template]!,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: order,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    return { merchantId, plan, schedule };
  }

  const pay = (id: string) => plans.recordManualPayment(id, {}, ACTOR);

  /** What `recogniseFinanceIncome` booked to revenue at completion (0 if not yet). */
  async function financeIncome(planId: string): Promise<number> {
    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(
        and(
          eq(schema.ledger_entries.transaction_id, `finance-income:${planId}`),
          eq(schema.ledger_entries.account_type, 'revenue'),
        ),
      );
    return rows.reduce((sum, r) => sum + Number(r.amount_pesewas), 0);
  }

  async function heldRows(planId: string) {
    return db
      .select()
      .from(schema.held_reserves)
      .where(eq(schema.held_reserves.customer_plan_id, planId));
  }

  it('claws the seller for the order share only, and the platform keeps less interest', async () => {
    const { merchantId, plan, schedule } = await activate('bnplInterest');
    expect(schedule.map((r) => r.amount_due_pesewas)).toEqual([20_000, 29_334, 29_333, 29_333]);
    await pay(schedule[0]!.id);
    await pay(schedule[1]!.id);
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);

    await plans.refundInstallment(schedule[1]!.id, {}, ACTOR);

    // 29,334 carries 26,667 of order (80,000 × 29,334 / 88,000) and 2,667 of
    // interest. The seller gives back the 26,667 less its MDR and reserve:
    // 1,067 and 1,333, so 24,267. It gave back all 29,334 before.
    expect(payableBefore - (await ledger.balanceOf('merchant_payable', merchantId))).toBe(24_267);

    await pay(schedule[2]!.id);
    await pay(schedule[3]!.id);
    expect((await plans.get(plan.id)).status).toBe('completed');
    // The platform earns the interest on what the customer kept: 8,000 less
    // the 2,667 handed back. It kept 7,996 of it before.
    expect(await financeIncome(plan.id)).toBe(8_000 - 2_667);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(0);
  });

  it('forgives every instalment of a full return, interest and all', async () => {
    const { merchantId, plan, schedule } = await activate('bnplInterest');
    for (const row of schedule) await pay(row.id);
    const revenueBefore = await ledger.balanceOf('revenue', 'platform');

    // The last of these was refused before: the seller had been clawed for
    // interest on the first three and had too little credit left.
    for (const row of schedule) await plans.refundInstallment(row.id, {}, ACTOR);

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    expect(await payouts.creditedNotReversed(plan.id)).toBe(0);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(0);
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(108_000);
    // Revenue hands back the 8,000 of interest and the 4,000 of MDR (one
    // pesewa over, from rounding each reversal's MDR on its own).
    expect(revenueBefore - (await ledger.balanceOf('revenue', 'platform'))).toBe(12_001);
  });

  it('forgives a "Pay in 6" plan row by row, to the last pesewa', async () => {
    // 17,919 → 5,376 then 2,509 × 3 and 2,508 × 2. Scaling the clawback to
    // whole basis points clawed 2,509 for a 2,508 row, and the last row was
    // then refused for want of 1 pesewa of credit.
    const { plan, schedule } = await activate('payIn6', 17_919);
    expect(schedule.map((r) => r.amount_due_pesewas)).toEqual([
      5_376, 2_509, 2_509, 2_509, 2_508, 2_508,
    ]);
    for (const row of schedule) await pay(row.id);

    for (const row of schedule) await plans.refundInstallment(row.id, {}, ACTOR);

    expect(await payouts.creditedNotReversed(plan.id)).toBe(0);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(17_919);
  });

  it('leaves no credit stuck on the receivable when the payments had moved on to float', async () => {
    const { plan, schedule } = await activate('rtoInterest');
    for (const row of schedule.slice(0, 10)) await pay(row.id);
    // 108,334 paid against 100,000 owed: the receivable is retired and 8,334
    // waits in float.
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(8_334);

    // #5 is 10,833: 8,333 of order, 2,500 of interest. The clawback credits
    // the receivable 8,333; the cash comes back out of that first, then float.
    await plans.refundInstallment(schedule[4]!.id, {}, ACTOR);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(8_334 - 2_500);

    await pay(schedule[10]!.id);
    await pay(schedule[11]!.id);
    expect((await plans.get(plan.id)).status).toBe('completed');
    // 30,000 of interest less the 2,500 handed back. Float first left 8,331
    // stranded on the receivable and booked 21,666.
    expect(await financeIncome(plan.id)).toBe(27_500);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(0);
  });

  it('forgives a re-collected copy for the order share of the row it replaced', async () => {
    const { merchantId, plan, schedule } = await activate('bnplInterest');
    for (const row of schedule) await pay(row.id);
    const { recollect } = await plans.refundInstallment(
      schedule[1]!.id,
      { mode: 'recollect' },
      ACTOR,
    );
    await pay(recollect!.id);
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);

    await plans.refundInstallment(recollect!.id, {}, ACTOR);

    // The copy is row #2 again: 26,667 of order, as above.
    expect(payableBefore - (await ledger.balanceOf('merchant_payable', merchantId))).toBe(24_267);
    // Completed plan, finance income booked: its 2,667 comes back from revenue.
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    expect(await ledger.balanceOf('customer_float', plan.id)).toBe(0);
  });

  it('holds one reserve per accrual when a re-collect re-opens and re-completes a plan', async () => {
    const { plan, schedule } = await activate('hybrid');
    for (const row of schedule) await pay(row.id);
    const before = await heldRows(plan.id);
    expect(before).toHaveLength(2); // deposit slice and completion slice
    expect(before.every((r) => r.plan_completed_at !== null)).toBe(true);

    const { recollect } = await plans.refundInstallment(
      schedule.at(-1)!.id,
      { mode: 'recollect' },
      ACTOR,
    );
    // Owed again: the release clock waits for the next completion.
    expect((await heldRows(plan.id)).every((r) => r.plan_completed_at === null)).toBe(true);

    await pay(recollect!.id);
    const after = await heldRows(plan.id);
    // The replayed completion accrual booked nothing, so it holds nothing.
    expect(after).toHaveLength(2);
    expect(after.reduce((sum, r) => sum + r.amount_pesewas, 0)).toBe(7_000);
    expect(after.every((r) => r.plan_completed_at !== null)).toBe(true);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(7_000);
  });

  it('writes off a re-collected layaway instalment when the plan then defaults', async () => {
    const { merchantId, plan, schedule } = await activate('layaway');
    for (const row of schedule) await pay(row.id);
    const payable = await ledger.balanceOf('merchant_payable', merchantId);

    await plans.refundInstallment(schedule.at(-1)!.id, { mode: 'recollect' }, ACTOR);
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(-25_000);

    await plans.markPlanDefaulted(plan.id, { reason: 'stopped paying' }, ACTOR);

    // It used to return early for layaway and leave the 25,000 open for good.
    expect(await ledger.balanceOf('receivable', plan.id)).toBe(0);
    // The 2% reserve first, then the platform: the seller was paid in full
    // against a paid-up plan, and re-billing the customer was not their call.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(payable);
  });

  it('refuses a re-collect due before today, and a date that does not exist', async () => {
    const { schedule } = await activate('bnplInterest');
    await pay(schedule[0]!.id);
    const now = new Date('2026-10-27T09:00:00Z');

    await expect(
      plans.refundInstallment(
        schedule[0]!.id,
        { mode: 'recollect', due_date: '2026-10-26' },
        ACTOR,
        now,
      ),
    ).rejects.toBeInstanceOf(InstallmentRefundDueDateInPastError);
    await expect(
      plans.refundInstallment(
        schedule[0]!.id,
        { mode: 'recollect', due_date: '2026-02-30' },
        ACTOR,
        now,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect((await plans.getInstallment(schedule[0]!.id)).status).toBe('paid');

    // Today is fine.
    const { recollect } = await plans.refundInstallment(
      schedule[0]!.id,
      { mode: 'recollect', due_date: '2026-10-27' },
      ACTOR,
      now,
    );
    expect(recollect!.due_date).toBe('2026-10-27');
  });
});
