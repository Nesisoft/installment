import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from './customer-plans.service';
import { PlanCashLedger } from './plan-cash-ledger';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PLATFORM_ACCOUNT_REF } from '../settlements/payout-recorder';
import { LateFeeService } from './late-fee.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

/** 2% a week, capped at 15% — the rate the product has always promised. */
const RATE_BPS = 200;
const CAP_BPS = 1_500;
const ORDER_PESEWAS = 100_000;

/**
 * The late-fee chain, end to end.
 *
 * `LateFeeService`'s own docstring diagnoses the bug it was written to fix: a
 * fee "never copied onto a plan". Migration 0015 added the rate and the cap to
 * both `plan_templates` and `customer_plans` — and the activation path still
 * did not copy them, so `accrue()`'s `late_fee_bps_per_week > 0` predicate
 * matched nothing on any plan ever created. The unit spec passed throughout
 * because it re-implements the arithmetic locally instead of calling the
 * service.
 *
 * These tests go through the real activation path, so they cannot pass unless
 * the rate actually reaches the plan.
 */
describe.skipIf(!RUN_DB)('late fee lifecycle (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ledger = new LedgerService(db);
  // With the cash leg wired, so a refund's ledger effect can be read back.
  const plansWithCash = new CustomerPlansService(
    db,
    audit,
    undefined,
    undefined,
    undefined,
    undefined,
    new PlanCashLedger(ledger),
  );
  const lateFees = new LateFeeService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `LF ${suffix}`,
          legal_name: `LF Ltd ${suffix}`,
          email: `lf+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Kofi',
          last_name: 'Boateng',
          email: `kofi+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * A template carrying a late-fee rate. The rate is written straight to the
   * column rather than through the DTO so that these tests stay honest about
   * what they are proving: that activation copies the rate, independently of
   * whether the create DTO happens to expose it.
   */
  async function templateWithLateFee(): Promise<string> {
    const id = (
      await planTemplates.create(
        {
          name: `BNPL late-fee ${randomUUID()}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    await db
      .update(schema.plan_templates)
      .set({ late_fee_bps_per_week: RATE_BPS, late_fee_cap_bps: CAP_BPS })
      .where(eq(schema.plan_templates.id, id));
    return id;
  }

  async function approved(templateId: string): Promise<string> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: ORDER_PESEWAS,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return app.id;
  }

  it('carries the template late-fee rate and cap onto the activated plan', async () => {
    const appId = await approved(await templateWithLateFee());
    const { plan } = await plans.activateFromApplication(appId, ACTOR);

    expect(plan.late_fee_bps_per_week).toBe(RATE_BPS);
    expect(plan.late_fee_cap_bps).toBe(CAP_BPS);
  });

  it('accrues a fee on an instalment past its grace date', async () => {
    // Instalment 1 is due +7d with 3 days' grace, so grace ends at +10d.
    // Backdating activation 27 days puts it 17 days past grace, and
    // `weeksSince` counts day 1 past grace as week 1 — floor(17/7)+1 = 3.
    // 17 sits mid-week, so the expectation cannot flip on time-of-day drift.
    const activatedAt = new Date(Date.now() - 27 * DAY_MS);
    const appId = await approved(await templateWithLateFee());
    const { schedule } = await plans.activateFromApplication(appId, ACTOR, activatedAt);
    const first = schedule[0]!;

    const accruals = await lateFees.accrue();
    const ours = accruals.find((a) => a.scheduleId === first.id);

    expect(ours).toBeDefined();
    expect(ours!.feePesewas).toBeGreaterThan(0);

    const [row] = await db
      .select({ fee: schema.installment_schedule.late_fee_pesewas })
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, first.id));
    expect(row!.fee).toBe(ours!.feePesewas);
    expect(ours!.weeksLate).toBe(3);
    // 3 weeks × 2% = 6% of the instalment, still under the 15% cap.
    expect(row!.fee).toBe(Math.round((first.amount_due_pesewas * RATE_BPS * 3) / 10_000));
    expect(ours!.capped).toBe(false);
  });

  it('never accrues beyond the cap however long a row sits', async () => {
    // 40 weeks late: uncapped would be 80%, the cap is 15%.
    const activatedAt = new Date(Date.now() - 290 * DAY_MS);
    const appId = await approved(await templateWithLateFee());
    const { schedule } = await plans.activateFromApplication(appId, ACTOR, activatedAt);
    const first = schedule[0]!;

    await lateFees.accrue();

    const [row] = await db
      .select({ fee: schema.installment_schedule.late_fee_pesewas })
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.id, first.id));
    expect(row!.fee).toBe(Math.round((first.amount_due_pesewas * CAP_BPS) / 10_000));
  });

  it('refunding a late-paid instalment restores the debt it settled, not the fee too', async () => {
    const plans = plansWithCash;
    const appId = await approved(await templateWithLateFee());
    const { plan, schedule } = await plans.activateFromApplication(appId, ACTOR);
    const first = schedule[0]!;
    const fee = 5_000;

    // Put a fee on the row directly, so this test isolates the refund
    // arithmetic from whether accrual works.
    await db
      .update(schema.installment_schedule)
      .set({ late_fee_pesewas: fee })
      .where(eq(schema.installment_schedule.id, first.id));

    const outstandingBefore = plan.outstanding_pesewas;

    const { plan: afterPay } = await plans.recordManualPayment(first.id, {}, ACTOR);
    expect(afterPay.outstanding_pesewas).toBe(outstandingBefore - first.amount_due_pesewas);

    const revenueBefore = await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF);
    const { plan: afterRefund } = await plans.refundInstallment(
      first.id,
      { mode: 'recollect' },
      ACTOR,
    );

    // The fee comes back out of revenue, where collection booked it. It used
    // to be re-opened as debt the customer owed, while revenue kept it.
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(revenueBefore - fee);
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(first.amount_due_pesewas + fee);

    // The customer is handed back amount_due + fee, but the plan's debt only
    // ever fell by amount_due — so that is all the refund may restore. Adding
    // the fee back inflates the debt and, on the first instalment of a plan,
    // breaches CHECK (outstanding_pesewas <= total_payable_pesewas).
    expect(afterRefund.outstanding_pesewas).toBe(outstandingBefore);
    expect(afterRefund.outstanding_pesewas).toBeLessThanOrEqual(afterRefund.total_payable_pesewas);
  });

  it('a plan on a template with no late-fee rate never grows one', async () => {
    const plainTemplate = (
      await planTemplates.create(
        {
          name: `BNPL plain ${randomUUID()}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    const appId = await approved(plainTemplate);
    const { plan, schedule } = await plans.activateFromApplication(
      appId,
      ACTOR,
      new Date(Date.now() - 31 * DAY_MS),
    );

    expect(plan.late_fee_bps_per_week).toBe(0);

    const accruals = await lateFees.accrue();
    const ids = new Set(schedule.map((r) => r.id));
    expect(accruals.filter((a) => ids.has(a.scheduleId))).toHaveLength(0);
  });
});
