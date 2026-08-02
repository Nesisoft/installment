import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { PayoutRecorder } from '../settlements/payout-recorder';
import { ReserveReleaseService } from '../settlements/reserve-release.service';
import { CustomerPlansService } from './customer-plans.service';
import { MANUAL_CASH_REF, PROVIDER_CASH_REF, PlanCashLedger } from './plan-cash-ledger';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const sched = schema.installment_schedule;

/**
 * S5 — the ledger records cash.
 *
 * The engine had no inbound leg at all: a plan could be paid in full and
 * `paystack_settlement` was never debited, `receivable` never retired. These
 * tests pin the waterfall that fixes it, per business model, because the
 * merchant accrual fires at a *different point in the lifecycle* for each one
 * and a single rule cannot be correct for all four (see migration 0008).
 */
describe.skipIf(!RUN_DB)('PlanCashLedger (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const cash = new PlanCashLedger(ledger);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const templates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves, undefined, cash);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    const s = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `L ${s}`,
          legal_name: `L Ltd ${s}`,
          email: `l+${s}@x.gh`,
          phone: `+2332${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Abena',
          last_name: 'Sarpong',
          email: `abena+${s}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function template(opts: {
    model: 'bnpl' | 'layaway' | 'hybrid' | 'rent_to_own';
    installments: number;
    downBps?: number;
    interestBps?: number;
  }): Promise<string> {
    const t = await templates.create(
      {
        name: `${opts.model} ${randomUUID()}`,
        business_model: opts.model,
        number_of_installments: opts.installments,
        installment_frequency_days: 30,
        down_payment_bps: opts.downBps ?? 0,
        interest_rate_bps: opts.interestBps ?? 0,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      ACTOR,
    );
    return t.id;
  }

  async function activate(templateId: string, orderPesewas: number) {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: orderPesewas,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    return plans.activateFromApplication(app.id, ACTOR);
  }

  /** Drives one installment to paid through the real settlement path. */
  async function payInstallment(scheduleId: string) {
    await db.update(sched).set({ status: 'processing' }).where(eq(sched.id, scheduleId));
    return plans.recordChargeSuccess(
      scheduleId,
      { providerReference: `ps-${randomUUID()}` },
      ACTOR,
    );
  }

  const bal = (type: string, ref: string) =>
    ledger.balanceOf(type as Parameters<typeof ledger.balanceOf>[0], ref);

  /**
   * Every transaction touching this plan must balance — the single most
   * important invariant in the system.
   *
   * Scoped to the plan rather than the whole table: the integration suite
   * shares one database and other specs deliberately leave artifacts (the
   * rollback-semantics spec writes a half-transaction on purpose), so a global
   * assertion here would report someone else's fixture as this test's failure.
   */
  async function assertPlanTransactionsBalance(planId: string) {
    const rows = await db.execute(sql`
      SELECT transaction_id,
             sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END) AS debits,
             sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END) AS credits
      FROM ledger_entries
      WHERE transaction_id IN (
        SELECT DISTINCT transaction_id FROM ledger_entries WHERE account_ref = ${planId}
      )
      GROUP BY transaction_id
      HAVING sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END)
          <> sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END)
    `);
    expect(rows.rows).toEqual([]);
  }

  it('bnpl: cash retires receivable directly and float never holds anything', async () => {
    const { plan, schedule } = await activate(
      await template({ model: 'bnpl', installments: 4 }),
      100_000,
    );

    // Accrual fired at activation: the platform already funded the merchant.
    expect(await bal('receivable', plan.id)).toBe(-100_000);

    await payInstallment(schedule[0]!.id);
    expect(await bal('receivable', plan.id)).toBe(-75_000);
    // Nothing is unattributed — the debt existed before the cash arrived.
    expect(await bal('customer_float', plan.id)).toBe(0);

    for (const row of schedule.slice(1)) await payInstallment(row.id);

    expect(await bal('receivable', plan.id)).toBe(0);
    expect(await bal('customer_float', plan.id)).toBe(0);
    expect(await bal('paystack_settlement', PROVIDER_CASH_REF)).toBeLessThanOrEqual(-100_000);
    await assertPlanTransactionsBalance(plan.id);
  });

  it('rent_to_own: accrual precedes cash like bnpl, over a long 12-installment tail', async () => {
    // Same accrual timing as bnpl (100% at activation) but a 12% reserve and a
    // 12-month tail, so the schedule generator distributes a remainder across
    // many rows. Worth its own case: if those rows did not sum back to the
    // order amount, receivable would not close out and the residue would be
    // permanent on an append-only table.
    const { plan, schedule } = await activate(
      await template({ model: 'rent_to_own', installments: 12 }),
      120_000,
    );
    expect(await bal('receivable', plan.id)).toBe(-120_000);

    for (const row of schedule) await payInstallment(row.id);

    expect(await bal('receivable', plan.id)).toBe(0);
    expect(await bal('customer_float', plan.id)).toBe(0);
    expect(await bal('reserve_held', plan.id)).toBe(14_400); // 12% of 120,000
    await assertPlanTransactionsBalance(plan.id);
  });

  it('layaway: cash is held in float until completion, then attributed', async () => {
    const { plan, schedule } = await activate(
      await template({ model: 'layaway', installments: 4 }),
      100_000,
    );

    // No accrual yet — the merchant is not credited until the plan completes.
    expect(await bal('receivable', plan.id)).toBe(0);

    await payInstallment(schedule[0]!.id);
    // The cash is real but unattributed. Crediting `receivable` here would put
    // a credit balance on a debit-normal asset and assert a debt we do not owe.
    expect(await bal('customer_float', plan.id)).toBe(25_000);
    expect(await bal('receivable', plan.id)).toBe(0);

    await payInstallment(schedule[1]!.id);
    await payInstallment(schedule[2]!.id);
    expect(await bal('customer_float', plan.id)).toBe(75_000);

    await payInstallment(schedule[3]!.id); // completes → accrual fires → sweep
    expect(await bal('customer_float', plan.id)).toBe(0);
    expect(await bal('receivable', plan.id)).toBe(0);
    await assertPlanTransactionsBalance(plan.id);
  });

  it('hybrid: float absorbs the gap between the two partial recognitions', async () => {
    const { plan, schedule } = await activate(
      await template({ model: 'hybrid', installments: 4, downBps: 3_000 }),
      100_000,
    );

    // Down payment settles → 40% accrues → the sweep applies the cash to it.
    await payInstallment(schedule[0]!.id);
    const afterDown = (await bal('receivable', plan.id)) + (await bal('customer_float', plan.id));
    // Net position: 40,000 recognised as owed, 30,000 collected → 10,000 owed.
    expect(afterDown).toBe(-10_000);

    for (const row of schedule.slice(1)) await payInstallment(row.id);

    expect(await bal('receivable', plan.id)).toBe(0);
    expect(await bal('customer_float', plan.id)).toBe(0);
    await assertPlanTransactionsBalance(plan.id);
  });

  it('recognises interest as finance income rather than stranding it in float', async () => {
    // Collections total order + interest, but an accrual only ever debits the
    // order amount. Without the completion drain the difference would sit in
    // float forever on an append-only table.
    const { plan, schedule } = await activate(
      await template({ model: 'bnpl', installments: 4, interestBps: 1_000 }),
      100_000,
    );

    for (const row of schedule) await payInstallment(row.id);

    expect(await bal('receivable', plan.id)).toBe(0);
    expect(await bal('customer_float', plan.id)).toBe(0);

    // Assert the plan-scoped posting rather than the global `revenue` balance:
    // `platform` is a single shared account_ref, so a delta on it is perturbed
    // by anything else running against the same database.
    const financeIncome = await db.execute(sql`
      SELECT amount_pesewas FROM ledger_entries
      WHERE transaction_id = ${`finance-income:${plan.id}`}
        AND account_type = 'revenue' AND direction = 'credit'
    `);
    // Collections totalled 110,000 (order + 10% interest); the accrual only
    // debited the 100,000 order, so 10,000 is finance income.
    expect((financeIncome.rows as Array<{ amount_pesewas: string }>)[0]?.amount_pesewas).toBe(
      '10000',
    );
    await assertPlanTransactionsBalance(plan.id);
  });

  it('keeps out-of-band cash out of the provider reconciliation account', async () => {
    const { schedule } = await activate(
      await template({ model: 'bnpl', installments: 4 }),
      100_000,
    );
    const manualBefore = await bal('paystack_settlement', MANUAL_CASH_REF);

    await db.update(sched).set({ status: 'due' }).where(eq(sched.id, schedule[0]!.id));
    await plans.recordManualPayment(schedule[0]!.id, { reason: 'field agent cash' }, ACTOR);

    // Booking this to 'main' would poison the exact balance the cash-in leg
    // exists to make reconcilable against Paystack.
    expect(await bal('paystack_settlement', MANUAL_CASH_REF)).toBe(manualBefore - 25_000);
  });

  it('is replay-safe: re-booking a collection is a no-op', async () => {
    const { plan, schedule } = await activate(
      await template({ model: 'bnpl', installments: 4 }),
      100_000,
    );
    await payInstallment(schedule[0]!.id);
    const after = await bal('receivable', plan.id);

    await cash.collect(
      {
        scheduleId: schedule[0]!.id,
        customerPlanId: plan.id,
        amountDuePesewas: 25_000,
        lateFeePesewas: 0,
        cashRef: PROVIDER_CASH_REF,
      },
      db,
    );
    expect(await bal('receivable', plan.id)).toBe(after);
  });

  it('refund re-opens the receivable and records what is owed back', async () => {
    const { plan, schedule } = await activate(
      await template({ model: 'bnpl', installments: 4 }),
      100_000,
    );
    await payInstallment(schedule[0]!.id);
    await payInstallment(schedule[1]!.id);
    expect(await bal('receivable', plan.id)).toBe(-50_000);

    await plans.refundInstallment(schedule[0]!.id, { reason: 'goods returned' }, ACTOR);

    // The accrual clawback alone would leave receivable at -25,000, understating
    // the debt: the collection's own credit must be undone too.
    expect(await bal('receivable', plan.id)).toBe(-50_000);
    // And the platform now owes the customer their money back.
    expect(await bal('refund_payable', plan.id)).toBe(25_000);
    await assertPlanTransactionsBalance(plan.id);
  });

  it('never lets a single transaction post the same account twice', async () => {
    // ledger_posting_identity_uq is what actually closes the check-then-insert
    // TOCTOU window in every write site.
    await expect(
      db.execute(sql`
        INSERT INTO ledger_entries (transaction_id, account_type, account_ref, direction, amount_pesewas, description)
        VALUES ('dup-test-tx', 'revenue', 'platform', 'credit', 1, 'a'),
               ('dup-test-tx', 'revenue', 'platform', 'credit', 1, 'b')
      `),
    ).rejects.toThrow();
  });
});
