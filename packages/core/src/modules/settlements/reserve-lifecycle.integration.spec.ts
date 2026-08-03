import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from './payout-recorder';
import { ReserveReleaseService } from './reserve-release.service';
import { DefaultService } from './default.service';
import { reserveReleaseDate } from './reserve-policy';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

/**
 * S6 — reserves come back out.
 *
 * The reserve is 2-12% of every order, withheld as the platform's security and
 * returned once the model says the risk has passed. Two of the three release
 * policies had no way to fire: `after_delivery` waited on a stamp nothing wrote,
 * and both buffer policies waited on a completion that a defaulted plan can
 * never reach. For those plans the reserve was not withheld — it was kept.
 */
describe('reserveReleaseDate', () => {
  const base = {
    held_at: '2026-01-01T00:00:00.000Z',
    plan_completed_at: null,
    delivered_at: null,
    plan_defaulted_at: null,
  };

  it('returns null while the policy is still waiting on its trigger', () => {
    // Layaway waits on delivery. Before S6 this returned the year 275760, a
    // sentinel that read as a real maturity date to anything downstream.
    expect(reserveReleaseDate({ ...base, business_model: 'layaway' })).toBeNull();
    expect(reserveReleaseDate({ ...base, business_model: 'bnpl' })).toBeNull();
  });

  it('matures a delivery-gated reserve 7 days after delivery', () => {
    const at = reserveReleaseDate({
      ...base,
      business_model: 'layaway',
      delivered_at: '2026-03-01T00:00:00.000Z',
    });
    expect(at?.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('treats a default as the terminal trigger for both buffer policies', () => {
    // A defaulted plan will never complete and will never be delivered, so
    // without this the reserve left over after the loss allocation is stranded.
    const defaultedAt = '2026-04-01T00:00:00.000Z';
    expect(
      reserveReleaseDate({
        ...base,
        business_model: 'bnpl',
        plan_defaulted_at: defaultedAt,
      })?.toISOString(),
    ).toBe('2026-04-15T00:00:00.000Z'); // +14d
    expect(
      reserveReleaseDate({
        ...base,
        business_model: 'layaway',
        plan_defaulted_at: defaultedAt,
      })?.toISOString(),
    ).toBe('2026-04-08T00:00:00.000Z'); // +7d
  });

  it('prefers the real trigger over the default when both are stamped', () => {
    const at = reserveReleaseDate({
      ...base,
      business_model: 'bnpl',
      plan_completed_at: '2026-05-01T00:00:00.000Z',
      plan_defaulted_at: '2026-09-01T00:00:00.000Z',
    });
    expect(at?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  it('starts a rolling reserve at the hold date, trigger or not', () => {
    const at = reserveReleaseDate({ ...base, business_model: 'rent_to_own' });
    expect(at?.toISOString()).toBe(base.held_at);
  });

  it('returns null for a model it does not know', () => {
    expect(reserveReleaseDate({ ...base, business_model: 'crowdfunded' })).toBeNull();
  });
});

describe.skipIf(!RUN_DB)('Reserve lifecycle (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const defaults = new DefaultService(db, ledger, reserves);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves, defaults);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;
  let layawayTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-life ${suffix}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    layawayTemplateId = (
      await planTemplates.create(
        {
          name: `Layaway-life ${suffix}`,
          business_model: 'layaway',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshMerchant(): Promise<string> {
    const suffix = randomUUID();
    return (
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
  }

  async function freshCustomer(): Promise<string> {
    const suffix = randomUUID();
    return (
      await customers.register(
        {
          first_name: 'Reserve',
          last_name: 'Life',
          email: `rl+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function activate(
    templateId: string,
    merchantId: string,
    customerId: string,
    order = 100_000,
  ) {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: order,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  /** The `default:{plan}` transaction's rows, which is where the split is visible. */
  async function defaultEntries(planId: string) {
    return db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `default:${planId}`));
  }

  async function heldRow(planId: string) {
    return (
      await db
        .select()
        .from(schema.held_reserves)
        .where(eq(schema.held_reserves.customer_plan_id, planId))
    )[0];
  }

  it('releases a layaway reserve once delivery is recorded', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate(layawayTemplateId, merchantId, await freshCustomer());

    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    // Layaway accrues 100% at completion: 3% MDR, 2% reserve.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_000);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(95_000);

    // A year on, still withheld: completion is not the trigger for layaway, and
    // before S6 nothing in the system could ever stamp the one that is.
    const stranded = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 365 * DAY_MS),
    );
    expect(stranded.totalReleasedPesewas).toBe(0);

    const deliveredAt = new Date();
    const delivered = await plans.markDelivered(plan.id, { deliveredAt }, ACTOR);
    expect(delivered.product_delivered_at).not.toBeNull();
    expect((await heldRow(plan.id))!.delivered_at).not.toBeNull();

    // Day 6: inside the 7-day buffer.
    const early = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(deliveredAt.getTime() + 6 * DAY_MS),
    );
    expect(early.totalReleasedPesewas).toBe(0);

    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(deliveredAt.getTime() + 8 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(2_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(95_000 + 2_000);

    const events = await db
      .select()
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, plan.id),
          eq(schema.audit_events.event_type, 'customer_plan.delivered'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('recording delivery twice does not move the release clock', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate(layawayTemplateId, merchantId, await freshCustomer());
    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);

    const first = new Date('2026-06-01T00:00:00.000Z');
    await plans.markDelivered(plan.id, { deliveredAt: first }, ACTOR);
    // A duplicate submission a month later must not push the reserve out.
    const second = await plans.markDelivered(
      plan.id,
      { deliveredAt: new Date('2026-07-01T00:00:00.000Z') },
      ACTOR,
    );

    // Postgres hands timestamps back in its own format, so compare instants.
    expect(new Date(second.product_delivered_at!).getTime()).toBe(first.getTime());
    expect(new Date((await heldRow(plan.id))!.delivered_at!).getTime()).toBe(first.getTime());
    const events = await db
      .select()
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, plan.id),
          eq(schema.audit_events.event_type, 'customer_plan.delivered'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('a BNPL default consumes the merchant reserve before the platform pool', async () => {
    const merchantId = await freshMerchant();
    const { plan } = await activate(bnplTemplateId, merchantId, await freshCustomer());
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(5_000);
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);

    await plans.markPlanDefaulted(plan.id, { reason: 'no contact 90d' }, ACTOR);

    // The 5% withheld for default risk is what covers the default. Before S6
    // BNPL booked the whole loss to the pool and left the reserve intact — the
    // merchant paid for cover it was never given.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    const entries = await defaultEntries(plan.id);
    const find = (type: string, direction: string) =>
      entries.find((e) => e.account_type === type && e.direction === direction);
    expect(find('receivable', 'credit')?.amount_pesewas).toBe(100_000);
    expect(find('reserve_held', 'debit')?.amount_pesewas).toBe(5_000);
    expect(find('default_pool', 'debit')?.amount_pesewas).toBe(95_000);

    // BNPL still never claws past the reserve — that is the model's risk split.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(payableBefore);
    expect((await heldRow(plan.id))!.consumed_for_default_pesewas).toBe(5_000);
  });

  it('releases the reserve a default did not consume, on the default clock', async () => {
    const merchantId = await freshMerchant();
    const { plan } = await activate(bnplTemplateId, merchantId, await freshCustomer());
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);

    // Only 2,000 unrecovered — the 5,000 reserve covers it with 3,000 to spare.
    const defaultedAt = new Date();
    await plans.markPlanDefaulted(plan.id, { unrecoveredAmountPesewas: 2_000 }, ACTOR, defaultedAt);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(3_000);
    // The plan is defaulted, so it will never complete: the completion trigger
    // this policy waits on can no longer fire.
    expect((await heldRow(plan.id))!.plan_completed_at).toBeNull();
    expect((await heldRow(plan.id))!.plan_defaulted_at).not.toBeNull();

    // Day 13 of the 14-day buffer: not yet.
    const early = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(defaultedAt.getTime() + 13 * DAY_MS),
    );
    expect(early.totalReleasedPesewas).toBe(0);

    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(defaultedAt.getTime() + 15 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(3_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(payableBefore + 3_000);
    expect((await heldRow(plan.id))!.fully_released_at).not.toBeNull();
  });

  it('a refund after the reserve is gone claws the merchant, not the reserve', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, await freshCustomer());

    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    await reserves.releaseMaturedReserves(merchantId, new Date(Date.now() + 20 * DAY_MS));
    // Reserve fully returned to the merchant: 91,000 net + 5,000 released.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(96_000);

    // Now refund an installment. The 25% reversal wants to hand 1,250 of
    // reserve back to the customer side — but there is no reserve left, and
    // ledger_entries cannot be edited after the fact, so an uncapped debit
    // would leave reserve_held permanently negative.
    await plans.refundInstallment(schedule[0]!.id, { reason: 'returned' }, ACTOR);

    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    // The whole non-MDR share comes off what we owe the merchant instead:
    // 25,000 gross − 1,000 MDR − 0 reserve = 24,000.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(96_000 - 24_000);

    const refundRows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `refund:${schedule[0]!.id}:order_approved`));
    expect(refundRows.find((r) => r.account_type === 'reserve_held')).toBeUndefined();
    expect(refundRows.find((r) => r.account_type === 'merchant_payable')?.amount_pesewas).toBe(
      24_000,
    );
  });

  it('splits a refund across what reserve is left and the merchant', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, await freshCustomer());
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR); // plan stays active

    // Draw the reserve down to 500 with a partial default, leaving less than
    // the 1,250 the refund reversal would want.
    await plans.markPlanDefaulted(plan.id, { unrecoveredAmountPesewas: 4_500 }, ACTOR);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(500);
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);

    await plans.refundInstallment(schedule[0]!.id, { reason: 'returned' }, ACTOR);

    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0); // drained, never negative
    // 25,000 gross − 1,000 MDR − 500 reserve = 23,500 off the merchant.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(payableBefore - 23_500);
  });

  it('does not release from a stale row when a default lands mid-sweep', async () => {
    const merchantId = await freshMerchant();
    const { plan, schedule } = await activate(bnplTemplateId, merchantId, await freshCustomer());
    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    const rowId = (await heldRow(plan.id))!.id;

    const locked = deferred();
    const proceed = deferred();

    // A default lands while the nightly sweep is running: it takes the row's
    // lock first, draws the whole reserve down and closes the row.
    const competing = runInTransaction(db, async (tx) => {
      await tx
        .select()
        .from(schema.held_reserves)
        .where(eq(schema.held_reserves.id, rowId))
        .for('update')
        .limit(1);
      locked.resolve();
      await proceed.promise;
      await defaults.handleDefault(
        {
          customerPlanId: plan.id,
          merchantId,
          model: 'bnpl',
          unrecoveredAmountPesewas: 100_000,
        },
        tx,
      );
    });

    await locked.promise;
    // The sweep builds its candidate list now, while the row still reads as
    // open with 5,000 available — the stale snapshot it must not act on.
    const sweep = reserves.releaseMaturedReserves(merchantId, new Date(Date.now() + 20 * DAY_MS));
    // Fails outright if the release stops taking the row lock: without it the
    // sweep never waits, and goes on to book a release the default has already
    // spent.
    await waitUntilBlockedOnHeldReserves();
    proceed.resolve();
    await competing;
    const summary = await sweep;

    // Re-read under the lock, the row has nothing left to give.
    expect(summary.totalReleasedPesewas).toBe(0);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0); // not −5,000
    const after = (await heldRow(plan.id))!;
    expect(after.consumed_for_default_pesewas).toBe(5_000);
    expect(after.released_amount_pesewas).toBe(0);
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** Blocks until some backend is waiting on a held_reserves lock in this database. */
  async function waitUntilBlockedOnHeldReserves(): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%held_reserves%'
        LIMIT 1`);
      if (waiting.rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the reserve release never blocked on the held_reserves row lock');
  }
});
