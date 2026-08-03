import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { EventBus } from '../../shared/event-bus/event-bus';
import { RedisLock } from '../../shared/lock/redis-lock';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { AttemptRepository } from '../payments/attempt-repository';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { WebhookService } from '../webhooks/webhook.service';
import { MerchantsService } from '../merchants/merchants.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { ApplicationsService } from '../applications/applications.service';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { PlanCashLedger, PROVIDER_CASH_REF } from '../schedules/plan-cash-ledger';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PayoutRecorder } from '../settlements/payout-recorder';
import { ReserveReleaseService } from '../settlements/reserve-release.service';
import { ReconciliationService } from '../settlements/reconciliation.service';
import { SettlementService } from '../settlements/settlement.service';
import { RefundService, type RefundClient, refundReference } from './refund.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const ALWAYS_OPEN = { set: async () => 'OK' as const, eval: async () => 1 };

/**
 * S7 — refunds return money.
 *
 * Refunding an installment flipped the schedule, bumped the plan's balance back
 * up, reversed the merchant accrual and credited `refund_payable`. Nothing
 * discharged that liability and `PaystackClient` had no refund method, so the
 * console's refund button produced a complete set of books describing a payment
 * the customer never received — with no record anywhere to chase it by.
 */
describe.skipIf(!RUN_DB)('Refund lifecycle (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const cashLedger = new PlanCashLedger(ledger);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let bnplTemplateId: string;

  beforeAll(async () => {
    bnplTemplateId = (
      await planTemplates.create(
        {
          name: `BNPL-refund ${randomUUID()}`,
          business_model: 'bnpl',
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

  /** A refund client returning a scripted provider status. */
  function refundClient(status = 'processed'): RefundClient & { calls: string[] } {
    const state = {
      calls: [] as string[],
      async refund(req: { transaction: string }) {
        state.calls.push(req.transaction);
        return { data: { id: `RFD_${state.calls.length}`, status } };
      },
    };
    return state;
  }

  function throwingClient(message: string): RefundClient {
    return {
      async refund() {
        throw new Error(message);
      },
    };
  }

  function serviceWith(client?: RefundClient): RefundService {
    return new RefundService(db, ledger, audit, client);
  }

  function plansWith(refunds: RefundService): CustomerPlansService {
    return new CustomerPlansService(
      db,
      audit,
      undefined,
      payouts,
      reserves,
      undefined,
      cashLedger,
      refunds,
    );
  }

  async function freshCustomer(): Promise<string> {
    const suffix = randomUUID();
    return (
      await customers.register(
        {
          first_name: 'Refund',
          last_name: 'Test',
          email: `rf+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
  }

  async function activate(plans: CustomerPlansService, order = 100_000) {
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
    const app = await apps.submit(
      {
        customer_id: await freshCustomer(),
        merchant_id: merchantId,
        plan_template_id: bnplTemplateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: order,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const activated = await plans.activateFromApplication(app.id, ACTOR);
    return { ...activated, merchantId };
  }

  /**
   * Records the succeeded Paystack attempt a real charge would have left, so
   * the refund knows which transaction to reverse. Manual payments deliberately
   * have none.
   */
  async function chargedByPaystack(
    scheduleId: string,
    planId: string,
    amountPesewas: number,
  ): Promise<string> {
    const reference = `INSTL-${scheduleId}-1`;
    await db.insert(schema.payment_attempts).values({
      schedule_id: scheduleId,
      customer_plan_id: planId,
      provider: 'paystack',
      channel: 'auto_debit',
      payment_method: 'momo',
      amount_pesewas: amountPesewas,
      idempotency_key: `${scheduleId}:1`,
      provider_reference: reference,
      status: 'succeeded',
    });
    return reference;
  }

  async function refundRow(scheduleId: string) {
    return (
      await db.select().from(schema.refunds).where(eq(schema.refunds.schedule_id, scheduleId))
    )[0];
  }

  /** This plan's own share of the platform cash account, not the global balance. */
  async function cashOutFor(reference: string): Promise<number> {
    const rows = await db
      .select({ amount: schema.ledger_entries.amount_pesewas })
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `refund-paid:${reference}`));
    return rows.reduce((sum, r) => sum + Number(r.amount), 0);
  }

  it('records a chaseable obligation and returns the money to the customer', async () => {
    const client = refundClient('processed');
    const refunds = serviceWith(client);
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    const chargeRef = await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);

    await plans.refundInstallment(schedule[0]!.id, { reason: 'returned' }, ACTOR);

    // The obligation exists as a row, not only as a ledger balance nothing reads.
    const row = (await refundRow(schedule[0]!.id))!;
    expect(row.status).toBe('initiated');
    expect(row.method).toBe('paystack');
    expect(row.provider_transaction_reference).toBe(chargeRef);
    expect(row.amount_pesewas).toBe(25_000);
    // ...and we owe it.
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000);

    const summary = await refunds.runSweep();
    expect(summary.attempted).toBeGreaterThanOrEqual(1);
    expect(client.calls).toContain(chargeRef);

    // Discharged: the liability is settled and the cash left the platform.
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
    const reference = refundReference(schedule[0]!.id);
    expect(await cashOutFor(reference)).toBe(50_000); // debit 25k + credit 25k
    const settled = (await refundRow(schedule[0]!.id))!;
    expect(settled.status).toBe('succeeded');
    expect(settled.paystack_refund_id).not.toBeNull();
    expect(settled.succeeded_at).not.toBeNull();
  });

  it('stops the statement counting a refunded installment as paid', async () => {
    const refunds = serviceWith(refundClient());
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    let statement = await plans.getStatement(plan.id);
    expect(statement.summary.amountPaid).toBe('GHS 250.00');
    expect(statement.summary.outstanding).toBe('GHS 750.00');

    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    statement = await plans.getStatement(plan.id);

    // Before S7 this read GHS 250.00 paid against GHS 1,000.00 outstanding —
    // the same cedis credited as paid *and* added back to the balance.
    expect(statement.summary.amountPaid).toBe('GHS 0.00');
    expect(statement.summary.outstanding).toBe('GHS 1,000.00');
    expect(statement.lines[0]!.status).toBe('refunded');
    expect(statement.lines[0]!.amountPaid).toBe('GHS 0.00');
  });

  it('marks an out-of-band payment for manual return and never sends it to the provider', async () => {
    const client = refundClient();
    const refunds = serviceWith(client);
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    // Paid in cash to a field agent — no Paystack transaction exists to reverse.
    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);

    const row = (await refundRow(schedule[0]!.id))!;
    expect(row.method).toBe('manual');
    expect(row.provider_transaction_reference).toBeNull();

    // The sweep leaves it alone rather than retrying forever against a
    // transaction Paystack has never heard of.
    const before = client.calls.length;
    await refunds.runSweep();
    expect(client.calls.length).toBe(before);
    expect((await refundRow(schedule[0]!.id))!.status).toBe('initiated');
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000); // still owed

    // A human records the physical return, which books the same discharge.
    const settled = await refunds.settleManual(refundReference(schedule[0]!.id), ACTOR);
    expect(settled.status).toBe('succeeded');
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
  });

  it('parks a refund as unknown when the provider call throws, keeping the debt', async () => {
    const refunds = serviceWith(throwingClient('network timeout'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);

    const result = await refunds.disburse(refundReference(schedule[0]!.id));
    expect(result.outcome).toBe('unknown');

    const row = (await refundRow(schedule[0]!.id))!;
    expect(row.status).toBe('unknown');
    expect(row.last_error).toContain('network timeout');
    // The call may have reached Paystack. Assuming failure and re-sending is how
    // a customer gets refunded twice on an API with no client reference, so the
    // liability stands and nothing is discharged.
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000);
    expect(await cashOutFor(refundReference(schedule[0]!.id))).toBe(0);
  });

  it('keeps the debt standing when the provider rejects the refund', async () => {
    const refunds = serviceWith(refundClient('failed'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);

    const result = await refunds.disburse(refundReference(schedule[0]!.id));
    expect(result.outcome).toBe('failed');
    expect((await refundRow(schedule[0]!.id))!.status).toBe('failed');
    // We still owe the customer — a failed refund is not a resolved one.
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000);
  });

  it('resolves a pending refund through the reconciliation sweep', async () => {
    const refunds = serviceWith(refundClient('pending'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);

    const sent = await refunds.disburse(refundReference(schedule[0]!.id));
    expect(sent.outcome).toBe('pending_confirmation');
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000); // not yet gone

    const reconciler = new ReconciliationService(
      db,
      new SettlementService(db, ledger, audit, {
        async initiateTransfer() {
          throw new Error('not used');
        },
      }),
      {
        async verifyTransfer() {
          throw new Error('not used');
        },
      },
      refunds,
      {
        async verifyRefund() {
          return { data: { status: 'processed' } };
        },
      },
    );

    const summary = await reconciler.reconcilePendingRefunds();
    const mine = summary.results.find((r) => r.reference === refundReference(schedule[0]!.id));
    expect(mine?.outcome).toBe('settled');
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
  });

  it('leaves an unverifiable refund unresolved rather than guessing', async () => {
    const refunds = serviceWith(throwingClient('socket hang up'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    await refunds.disburse(refundReference(schedule[0]!.id)); // → unknown, no provider id

    const reconciler = new ReconciliationService(
      db,
      new SettlementService(db, ledger, audit, {
        async initiateTransfer() {
          throw new Error('not used');
        },
      }),
      {
        async verifyTransfer() {
          throw new Error('not used');
        },
      },
      refunds,
      {
        async verifyRefund() {
          throw new Error('verify should not be reachable without a provider id');
        },
      },
    );

    const summary = await reconciler.reconcilePendingRefunds();
    const mine = summary.results.find((r) => r.reference === refundReference(schedule[0]!.id));
    expect(mine?.outcome).toBe('unresolved');
    expect(mine?.reason).toMatch(/no provider refund id/);
    // Nothing was assumed in either direction.
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000);
  });

  it('discharges once when a webhook races the reconciliation sweep', async () => {
    const refunds = serviceWith(refundClient('pending'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    const reference = refundReference(schedule[0]!.id);
    await refunds.disburse(reference);

    // Both arrive: refund_payable must be debited exactly once on a ledger that
    // cannot be corrected afterwards.
    await Promise.all([
      refunds.confirmRefund(reference, 'succeeded'),
      refunds.confirmRefund(reference, 'succeeded'),
    ]);
    // ...and a late failure webhook must not undo a settled refund.
    await refunds.confirmRefund(reference, 'failed', { error: 'late webhook' });

    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
    expect(await cashOutFor(reference)).toBe(50_000); // one debit + one credit
    expect((await refundRow(schedule[0]!.id))!.status).toBe('succeeded');
  });

  it('submits a refund once when two workers pick it up together', async () => {
    const client = refundClient('processed');
    const refunds = serviceWith(client);
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    const chargeRef = await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    const reference = refundReference(schedule[0]!.id);

    // Paystack's refund API takes no client reference, so a duplicate
    // submission is a duplicate refund with no way to detect it afterwards.
    const [a, b] = await Promise.all([refunds.disburse(reference), refunds.disburse(reference)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['skipped', 'succeeded']);
    expect(client.calls.filter((c) => c === chargeRef)).toHaveLength(1);
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
  });

  it('records one refund per installment even if the flip is replayed', async () => {
    const refunds = serviceWith(refundClient());
    const plans = plansWith(refunds);
    const { schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    // `refunded` is terminal, so a second refund is refused by the state machine.
    await expect(plans.refundInstallment(schedule[0]!.id, {}, ACTOR)).rejects.toThrow();

    const rows = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.schedule_id, schedule[0]!.id));
    expect(rows).toHaveLength(1);
  });

  it('applies a refund.processed webhook via the original transaction reference', async () => {
    const refunds = serviceWith(refundClient('pending'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    const chargeRef = await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    await refunds.disburse(refundReference(schedule[0]!.id));
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(25_000);

    const alerts: Array<{ reason: string }> = [];
    const webhooks = new WebhookService(
      db,
      { verifySignature: () => true },
      new AttemptRepository(db),
      plans,
      new ScheduleStateService(db, audit, new RedisLock(ALWAYS_OPEN), new EventBus()),
      undefined,
      { unhandled: (d) => void alerts.push(d) },
      undefined,
      refunds,
    );

    // A refund event names the transaction that was refunded, never our record —
    // and carries no `reference` at all, so both the dedup key and the lookup
    // have to come off `transaction_reference`.
    const body = JSON.stringify({
      event: 'refund.processed',
      data: { transaction_reference: chargeRef, status: 'processed', amount: 25_000 },
    });
    const result = await webhooks.ingest(body, 'sig');

    expect(result.processed).toBe(true);
    expect(alerts).toHaveLength(0);
    expect(await ledger.balanceOf('refund_payable', plan.id)).toBe(0);
    expect((await refundRow(schedule[0]!.id))!.status).toBe('succeeded');

    // A replay of the same delivery is a no-op.
    const replay = await webhooks.ingest(body, 'sig');
    expect(replay.processed).toBe(false);
    expect(await cashOutFor(refundReference(schedule[0]!.id))).toBe(50_000);

    // ...but a *different* customer's refund must not be mistaken for one.
    // Refund events carry no `reference`, so keying the dedup table on it alone
    // filed every refund.processed under `refund.processed:no-ref` — the first
    // one swallowed all the rest, and those customers were never refunded.
    const second = await activate(plans);
    await plans.recordManualPayment(second.schedule[0]!.id, {}, ACTOR);
    const secondCharge = await chargedByPaystack(second.schedule[0]!.id, second.plan.id, 25_000);
    await plans.refundInstallment(second.schedule[0]!.id, {}, ACTOR);
    await refunds.disburse(refundReference(second.schedule[0]!.id));

    const secondResult = await webhooks.ingest(
      JSON.stringify({
        event: 'refund.processed',
        data: { transaction_reference: secondCharge, status: 'processed', amount: 25_000 },
      }),
      'sig',
    );
    expect(secondResult.processed).toBe(true);
    expect(await ledger.balanceOf('refund_payable', second.plan.id)).toBe(0);
  });

  it('books the discharge against the platform cash account', async () => {
    const refunds = serviceWith(refundClient('processed'));
    const plans = plansWith(refunds);
    const { plan, schedule } = await activate(plans);

    await plans.recordManualPayment(schedule[0]!.id, {}, ACTOR);
    await chargedByPaystack(schedule[0]!.id, plan.id, 25_000);
    await plans.refundInstallment(schedule[0]!.id, {}, ACTOR);
    const reference = refundReference(schedule[0]!.id);
    await refunds.disburse(reference);

    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `refund-paid:${reference}`));
    expect(rows).toHaveLength(2);
    const debit = rows.find((r) => r.direction === 'debit')!;
    const credit = rows.find((r) => r.direction === 'credit')!;
    expect(debit.account_type).toBe('refund_payable');
    expect(debit.account_ref).toBe(plan.id);
    expect(credit.account_type).toBe('paystack_settlement');
    expect(credit.account_ref).toBe(PROVIDER_CASH_REF);
    expect(Number(debit.amount_pesewas)).toBe(Number(credit.amount_pesewas));
  });
});
