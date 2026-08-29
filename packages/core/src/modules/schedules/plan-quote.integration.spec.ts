import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { PlanTemplateNotFoundError } from '../plans/errors';
import { PlanQuoteService } from './plan-quote.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * These have to run against real Postgres, because the bug they exist for was
 * invisible without it.
 *
 * `plan_template_ids` was filtered with `sql\`${pt.id} = ANY(${ids})\``. Drizzle
 * binds a JS array as ONE parameter, node-postgres sends it untyped, and
 * Postgres reads it as text — so the statement died with 22P02 comparing
 * `uuid = ANY(text)`. Every product page asks for a quote restricted to the
 * templates that product offers, so the instalment preview — the entire point
 * of the screen — answered 400 on every product in the catalogue. A unit test
 * with a fake database would have passed happily.
 */
describe.skipIf(!RUN_DB)('PlanQuoteService (integration)', () => {
  const { db, pool } = createTestDb();
  const templates = new PlanTemplatesService(db, new AuditLogger());
  const quotes = new PlanQuoteService(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const base = {
    business_model: 'bnpl' as const,
    installment_frequency_days: 7,
    interest_rate_bps: 0,
    service_fee_flat_pesewas: 0,
    grace_period_days: 3,
    min_amount_pesewas: 1_000,
    max_amount_pesewas: 5_000_000,
  };

  let payInFour: string;
  let payInThree: string;

  beforeAll(async () => {
    payInFour = (
      await templates.create(
        { ...base, name: 'Pay in 4', number_of_installments: 3, down_payment_bps: 4_000 },
        ACTOR,
      )
    ).id;
    payInThree = (
      await templates.create(
        { ...base, name: 'Pay in 3', number_of_installments: 2, down_payment_bps: 3_400 },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('quotes a single template id without tripping the uuid parameter binding', async () => {
    const result = await quotes.quote({
      amount_pesewas: 14_500,
      plan_template_ids: [payInFour],
    });

    expect(result.map((q) => q.plan_template_id)).toEqual([payInFour]);
  });

  it('quotes several template ids at once', async () => {
    const result = await quotes.quote({
      amount_pesewas: 50_000,
      plan_template_ids: [payInFour, payInThree],
    });

    expect(new Set(result.map((q) => q.plan_template_id))).toEqual(
      new Set([payInFour, payInThree]),
    );
  });

  it('restricts to the ids given rather than returning every active template', async () => {
    const result = await quotes.quote({
      amount_pesewas: 50_000,
      plan_template_ids: [payInThree],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.plan_template_id).toBe(payInThree);
  });

  it('returns nothing for an id that exists but is not a template we hold', async () => {
    // A well-formed uuid that matches no row is an empty result, not an error —
    // only the singular `plan_template_id` promises a specific template exists.
    const result = await quotes.quote({
      amount_pesewas: 14_500,
      plan_template_ids: ['00000000-0000-0000-0000-0000000000ff'],
    });

    expect(result).toEqual([]);
  });

  it('still quotes every eligible template when no ids are given', async () => {
    const result = await quotes.quote({ amount_pesewas: 50_000 });

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the singular plan_template_id path working alongside the plural', async () => {
    const result = await quotes.quote({
      amount_pesewas: 14_500,
      plan_template_id: payInFour,
    });

    expect(result).toHaveLength(1);
  });

  it('still raises for a singular id that matches nothing', async () => {
    await expect(
      quotes.quote({
        amount_pesewas: 14_500,
        plan_template_id: '00000000-0000-0000-0000-0000000000ff',
      }),
    ).rejects.toThrow(PlanTemplateNotFoundError);
  });

  /**
   * "Pay in 4" is a deposit plus THREE instalments — `number_of_installments`
   * excludes the deposit, so the schedule has four rows. Getting this backwards
   * tells a customer they owe a fifth payment.
   */
  it('returns a schedule whose length includes the deposit row', async () => {
    const [quote] = await quotes.quote({
      amount_pesewas: 14_500,
      plan_template_ids: [payInFour],
    });

    expect(quote!.number_of_installments).toBe(3);
    expect(quote!.installments).toHaveLength(4);
    expect(quote!.installments[0]!.kind).toBe('down_payment');
    expect(quote!.installments.reduce((sum, r) => sum + r.amount_pesewas, 0)).toBe(
      quote!.total_payable_pesewas,
    );
  });
});
