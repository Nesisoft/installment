import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

/**
 * The reserve sweep's failure behaviour.
 *
 * `releaseMaturedReserves` promises in its own docstring that "a failure on one
 * row doesn't roll back the others — a re-run picks up where it left off". The
 * per-row transaction delivers half of that: nothing already committed is
 * rolled back. The other half was never implemented — neither loop caught, so
 * one throwing row ended the sweep for every remaining row and every remaining
 * merchant.
 *
 * The NaN below is one way to produce such a row, and was reachable on any
 * `rolling_monthly` reserve smaller than its term in months.
 */
describe.skipIf(!RUN_DB)('reserve sweep resilience (integration)', () => {
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

  let rtoTemplateId: string;
  let customerId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    rtoTemplateId = (
      await planTemplates.create(
        {
          name: `RTO-sweep ${suffix}`,
          business_model: 'rent_to_own',
          number_of_installments: 12,
          installment_frequency_days: 30,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Reserve',
          last_name: 'Sweep',
          email: `rsw+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
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
          business_name: `MS ${suffix}`,
          legal_name: `MS Ltd ${suffix}`,
          email: `ms+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
  }

  async function activatedPlanId(merchantId: string): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: rtoTemplateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan } = await plans.activateFromApplication(app.id, ACTOR);
    return plan.id;
  }

  /**
   * A matured reserve row with a matching ledger balance, independent of the
   * accrual path so the amount can be set exactly.
   */
  async function maturedReserve(
    merchantId: string,
    planId: string,
    amountPesewas: number,
    heldDaysAgo = 60,
  ): Promise<string> {
    const heldAt = new Date(Date.now() - heldDaysAgo * DAY_MS);
    const row = await reserves.recordHeldReserve({
      merchantId,
      customerPlanId: planId,
      model: 'rent_to_own',
      amountPesewas,
      heldAt,
    });
    const transactionId = `test-hold:${row!.id}`;
    await ledger.record([
      {
        transactionId,
        accountType: 'merchant_payable',
        accountRef: merchantId,
        direction: 'debit',
        amountPesewas,
        description: 'test reserve withholding',
      },
      {
        transactionId,
        accountType: 'reserve_held',
        accountRef: planId,
        direction: 'credit',
        amountPesewas,
        description: 'test reserve withholding',
      },
    ]);
    return row!.id;
  }

  it('releases a rolling_monthly reserve smaller than its term instead of computing NaN', async () => {
    // 5 pesewas over a 12-month term: `Math.floor(5 / 12)` is 0, so the
    // per-month divisor was zero and every downstream guard — all of them
    // `<= 0` comparisons, which NaN fails — let the NaN through to the ledger.
    const merchantId = await freshMerchant();
    const planId = await activatedPlanId(merchantId);
    const reserveId = await maturedReserve(merchantId, planId, 5);

    const summary = await reserves.releaseMaturedReserves(merchantId);

    const released = summary.releases.find((r) => r.heldReserveId === reserveId);
    expect(released).toBeDefined();
    expect(Number.isNaN(released!.releasedPesewas)).toBe(false);
    expect(released!.releasedPesewas).toBe(5);
    expect(released!.fullyReleased).toBe(true);

    const [row] = await db
      .select()
      .from(schema.held_reserves)
      .where(eq(schema.held_reserves.id, reserveId));
    expect(row!.released_amount_pesewas).toBe(5);
    expect(row!.fully_released_at).not.toBeNull();
  });

  it('keeps sweeping after a row fails, and reports the failure', async () => {
    const merchantId = await freshMerchant();
    const planA = await activatedPlanId(merchantId);
    const planB = await activatedPlanId(merchantId);
    const bad = await maturedReserve(merchantId, planA, 24_000);
    const good = await maturedReserve(merchantId, planB, 36_000);

    // Fail exactly the posting for the first row, leaving the second healthy.
    const real = ledger.record.bind(ledger);
    const spy = vi.spyOn(ledger, 'record').mockImplementation(async (entries, tx) => {
      if (entries.some((e) => e.metadata?.held_reserve_id === bad)) {
        throw new Error('simulated provider/ledger failure');
      }
      return real(entries, tx);
    });

    try {
      const summary = await reserves.releaseMaturedReserves(merchantId);

      // The healthy row must still have been released.
      const released = summary.releases.find((r) => r.heldReserveId === good);
      expect(released).toBeDefined();
      expect(released!.releasedPesewas).toBeGreaterThan(0);

      // And the failure must be surfaced, not swallowed — a reserve that could
      // not be released is a merchant who has not been paid.
      expect(summary.failures.map((f) => f.heldReserveId)).toContain(bad);
      expect(summary.failures).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }

    const [badRow] = await db
      .select()
      .from(schema.held_reserves)
      .where(eq(schema.held_reserves.id, bad));
    expect(badRow!.released_amount_pesewas).toBe(0);
    expect(badRow!.fully_released_at).toBeNull();
  });

  it('runSweep carries on to the next merchant when one merchant throws', async () => {
    const merchantA = await freshMerchant();
    const merchantB = await freshMerchant();
    const planA = await activatedPlanId(merchantA);
    const planB = await activatedPlanId(merchantB);
    const bad = await maturedReserve(merchantA, planA, 24_000);
    const good = await maturedReserve(merchantB, planB, 36_000);

    const real = ledger.record.bind(ledger);
    const spy = vi.spyOn(ledger, 'record').mockImplementation(async (entries, tx) => {
      if (entries.some((e) => e.metadata?.held_reserve_id === bad)) {
        throw new Error('simulated provider/ledger failure');
      }
      return real(entries, tx);
    });

    try {
      const summary = await reserves.runSweep();
      const mb = summary.perMerchant.find((m) => m.merchantId === merchantB);
      expect(mb?.releases.some((r) => r.heldReserveId === good)).toBe(true);
      expect(summary.failedReleases).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
