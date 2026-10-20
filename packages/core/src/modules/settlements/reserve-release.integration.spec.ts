import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
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

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

describe.skipIf(!RUN_DB)('ReserveReleaseService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;
  let layawayTemplateId: string;
  let rtoTemplateId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-rsv ${suffix}`,
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
          name: `Layaway-rsv ${suffix}`,
          business_model: 'layaway',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    rtoTemplateId = (
      await planTemplates.create(
        {
          name: `RTO-rsv ${suffix}`,
          business_model: 'rent_to_own',
          number_of_installments: 12,
          installment_frequency_days: 30,
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
          last_name: 'Test',
          email: `rs+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function approvedPlan(
    templateId: string,
    merchantId: string,
    customerId: string,
    orderAmountPesewas = 100_000,
  ): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: orderAmountPesewas,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return app.id;
  }

  async function loadHeldRows(merchantId: string) {
    return db
      .select()
      .from(schema.held_reserves)
      .where(eq(schema.held_reserves.merchant_id, merchantId));
  }

  it('records a held_reserves row when the order_approved accrual withholds reserve', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(bnplTemplateId, merchantId, customerId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    const rows = await loadHeldRows(merchantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customer_plan_id).toBe(plan.id);
    expect(rows[0]!.amount_pesewas).toBe(5_000); // 5% of 100k
    expect(rows[0]!.released_amount_pesewas).toBe(0);
    expect(rows[0]!.plan_completed_at).toBeNull();
    expect(rows[0]!.fully_released_at).toBeNull();
  });

  it('does not release a BNPL reserve before plan completion + 14-day buffer', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(bnplTemplateId, merchantId, customerId);
    await plans.activateFromApplication(appId, ACTOR);

    // Pre-completion: plan_completed_at is null → not yet matured.
    const summary = await reserves.releaseMaturedReserves(merchantId, new Date());
    expect(summary.totalReleasedPesewas).toBe(0);
    expect(summary.releases).toHaveLength(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000); // unchanged
  });

  it('releases the BNPL reserve once the plan completes and the 14d buffer matures', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(bnplTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    expect((await plans.get(plan.id)).status).toBe('completed');

    // Day 13: still within buffer.
    const early = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 13 * DAY_MS),
    );
    expect(early.totalReleasedPesewas).toBe(0);

    // Day 15: matured.
    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 15 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(5_000);
    expect(matured.releases).toHaveLength(1);
    expect(matured.releases[0]!.fullyReleased).toBe(true);

    // Reserve liability cleared, merchant payable bumped by the released amount.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000 + 5_000);

    // Replay is idempotent — already-released rows stay closed.
    const replay = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 30 * DAY_MS),
    );
    expect(replay.totalReleasedPesewas).toBe(0);
  });

  it('releases the layaway reserve after delivery + 7d buffer (not on completion alone)', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(layawayTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    // After completion: 100k accrued, 2k reserve withheld.
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_000);

    // Completion alone doesn't release for layaway — needs delivered_at.
    const completionOnly = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 30 * DAY_MS),
    );
    expect(completionOnly.totalReleasedPesewas).toBe(0);

    // Mark delivered, then advance past the 7-day buffer.
    const deliveredAt = new Date();
    await reserves.markDelivered(plan.id, deliveredAt);
    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(deliveredAt.getTime() + 8 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(2_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
  });

  it('releases a layaway reserve when delivery was recorded before the plan completed', async () => {
    // Layaway withholds its reserve at completion, so a delivery recorded
    // earlier stamped no row — and recording it again is a no-op on a plan
    // already marked delivered. The row created at completion waited on a
    // trigger that had already fired, and was held for good.
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(layawayTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    const deliveredAt = new Date();
    await plans.markDelivered(plan.id, { deliveredAt }, ACTOR);
    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(2_000);

    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(deliveredAt.getTime() + 8 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(2_000);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
  });

  it('gives a reserve recorded after a default the default as its release trigger', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(bnplTemplateId, merchantId, customerId);
    const { plan } = await plans.activateFromApplication(appId, ACTOR);
    const defaultedAt = new Date();
    await db
      .update(schema.customer_plans)
      .set({ status: 'defaulted', defaulted_at: defaultedAt.toISOString() })
      .where(eq(schema.customer_plans.id, plan.id));

    const row = await reserves.recordHeldReserve({
      merchantId,
      customerPlanId: plan.id,
      model: 'bnpl',
      amountPesewas: 1_000,
    });

    expect(row?.plan_defaulted_at).not.toBeNull();
    expect(new Date(row!.plan_defaulted_at!).getTime()).toBe(defaultedAt.getTime());
  });

  it('rolls a rent_to_own reserve out 1/12 per month, flushing dust at term', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(rtoTemplateId, merchantId, customerId, 120_010); // %12 not divisible
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    // RTO: 12% reserve of 120,010 = 14,401.20 → 14,401 pesewas withheld (HALF_UP)
    const reserveTotal = await ledger.balanceOf('reserve_held', plan.id);
    expect(reserveTotal).toBe(14_401);

    const t0 = Date.now();
    // Month 1: 1/12 of 14,401 ⌊⌋ = 1_200 released.
    const m1 = await reserves.releaseMaturedReserves(merchantId, new Date(t0 + 31 * DAY_MS));
    expect(m1.totalReleasedPesewas).toBe(1_200);

    // Month 2: another 1_200 (cumulative 2_400).
    const m2 = await reserves.releaseMaturedReserves(merchantId, new Date(t0 + 61 * DAY_MS));
    expect(m2.totalReleasedPesewas).toBe(1_200);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBeGreaterThan(0);

    // Term end (month 12+): flush remaining 14_401 − 2_400 = 12_001 in one shot.
    const flush = await reserves.releaseMaturedReserves(merchantId, new Date(t0 + 400 * DAY_MS));
    expect(flush.totalReleasedPesewas).toBe(14_401 - 2_400);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);
  });

  it('caps a release at the live ledger balance so a prior refund cannot drive it negative', async () => {
    const merchantId = await freshMerchant();
    const customerId = await freshCustomer();
    const appId = await approvedPlan(bnplTemplateId, merchantId, customerId);
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);

    for (const row of schedule) await plans.recordManualPayment(row.id, {}, ACTOR);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(5_000);

    // A refund reverses 25% of the accrual — including 1_250 of the reserve.
    await plans.refundInstallment(schedule[0]!.id, { reason: 'returned' }, ACTOR);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(5_000 - 1_250);

    // held_reserves still thinks 5_000 is owed; release caps at the live ledger
    // balance (3_750) — never breaks the invariant.
    const matured = await reserves.releaseMaturedReserves(
      merchantId,
      new Date(Date.now() + 30 * DAY_MS),
    );
    expect(matured.totalReleasedPesewas).toBe(3_750);
    expect(await ledger.balanceOf('reserve_held', plan.id)).toBe(0);

    // Row is closed (ledger has nothing left for the plan) even though the
    // held_reserves bookkeeping never reached its full amount.
    const rows = await db
      .select()
      .from(schema.held_reserves)
      .where(
        and(
          eq(schema.held_reserves.merchant_id, merchantId),
          eq(schema.held_reserves.customer_plan_id, plan.id),
        ),
      );
    expect(rows[0]!.fully_released_at).not.toBeNull();
  });
});
