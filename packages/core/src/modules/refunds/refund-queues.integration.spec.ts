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
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { SettlementService } from '../settlements/settlement.service';
import {
  ReconciliationService,
  type RefundVerifyClient,
} from '../settlements/reconciliation.service';
import {
  REFUND_QUEUES,
  RefundNotSettleableError,
  RefundOutcomeConflictError,
  RefundService,
  type RefundClient,
  type RefundQueue,
  type RefundQueueTotal,
} from './refund.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The console's refunds page: which queue each refund is in, what the totals
 * say, and paying one back by hand — including one Paystack refused, which
 * used to be final with the customer still owed.
 */
describe.skipIf(!RUN_DB)('refund queues (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const refunds = new RefundService(db, ledger, audit);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const planTemplates = new PlanTemplatesService(db, audit);
  const apps = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const STAFF = { actorId: randomUUID(), actorType: 'admin' as const };

  let templateId: string;
  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    merchantId = (
      await merchants.create(
        {
          business_name: `RQ ${suffix}`,
          legal_name: `RQ Ltd ${suffix}`,
          email: `rq+${suffix}@x.gh`,
          phone: '+233244000000',
        },
        ACTOR,
      )
    ).id;
    customerId = (
      await customers.register(
        {
          first_name: 'Abena',
          last_name: 'Owed',
          email: `rq+${suffix}@x.gh`,
          phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        },
        ACTOR,
      )
    ).id;
    templateId = (
      await planTemplates.create(
        {
          name: `BNPL-rq ${suffix}`,
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

  async function freshSchedule(): Promise<{ planId: string; scheduleId: string }> {
    const app = await apps.submit(
      {
        customer_id: customerId,
        merchant_id: merchantId,
        plan_template_id: templateId,
        order_reference: `ORD-${randomUUID()}`,
        order_amount_pesewas: 100_000,
        merchant_category: 'electronics',
      },
      ACTOR,
    );
    await apps.recordDecision(app.id, { outcome: 'approved' }, ACTOR);
    const { plan, schedule } = await plans.activateFromApplication(app.id, ACTOR);
    return { planId: plan.id, scheduleId: schedule[0]!.id };
  }

  /** A refund row in a given state, owed under a real plan, as the engine leaves them. */
  async function refundIn(
    state: {
      method?: 'paystack' | 'manual';
      status?: 'initiated' | 'pending_confirmation' | 'unknown' | 'failed' | 'succeeded';
      submitted?: boolean;
      /** How long ago it was sent. Default ten minutes: long settled. */
      sentAgoMs?: number;
      /** The refund Paystack holds for it, once someone has found one. */
      paystackRefundId?: string;
    },
    amount = 25_000,
  ): Promise<{ reference: string; planId: string }> {
    const { planId, scheduleId } = await freshSchedule();
    const reference = `refund:${randomUUID()}`;
    const method = state.method ?? 'paystack';
    await db.insert(schema.refunds).values({
      customer_plan_id: planId,
      schedule_id: scheduleId,
      amount_pesewas: amount,
      reference,
      method,
      provider_transaction_reference: method === 'paystack' ? `ps_${randomUUID()}` : null,
      status: state.status ?? 'initiated',
      ...(state.submitted
        ? { submitted_at: new Date(Date.now() - (state.sentAgoMs ?? 10 * 60_000)).toISOString() }
        : {}),
      ...(state.paystackRefundId ? { paystack_refund_id: state.paystackRefundId } : {}),
    });
    // The liability the refund discharges, as `reverseCollection` books it.
    await ledger.record([
      {
        transactionId: `test-owed:${reference}`,
        accountType: 'refund_payable',
        accountRef: planId,
        direction: 'credit',
        amountPesewas: amount,
        description: 'owed back',
      },
      {
        transactionId: `test-owed:${reference}`,
        accountType: 'revenue',
        accountRef: 'platform',
        direction: 'debit',
        amountPesewas: amount,
        description: 'owed back',
      },
    ]);
    return { reference, planId };
  }

  const byQueue = (totals: RefundQueueTotal[]) =>
    Object.fromEntries(totals.map((t) => [t.queue, t])) as Record<RefundQueue, RefundQueueTotal>;

  it('puts each refund in the queue that says what has to happen to it', async () => {
    const before = byQueue(await refunds.summary());
    const made: Record<RefundQueue, string[]> = Object.fromEntries(
      REFUND_QUEUES.map((q) => [q, [] as string[]]),
    ) as Record<RefundQueue, string[]>;
    made.to_send.push((await refundIn({})).reference);
    made.in_flight.push(
      (await refundIn({ status: 'pending_confirmation', submitted: true })).reference,
    );
    made.unresolved.push((await refundIn({ status: 'unknown', submitted: true })).reference);
    // Claimed for sending, and nothing recorded after: possibly sent.
    made.unresolved.push((await refundIn({ submitted: true })).reference);
    // Found at Paystack by the reconciler, whatever the status still says:
    // Paystack is paying it.
    made.in_flight.push(
      (await refundIn({ status: 'unknown', submitted: true, paystackRefundId: '91001' })).reference,
    );
    made.in_flight.push((await refundIn({ submitted: true, paystackRefundId: '91002' })).reference);
    made.failed.push((await refundIn({ status: 'failed', submitted: true })).reference);
    made.to_pay_by_hand.push((await refundIn({ method: 'manual' })).reference);
    made.paid.push((await refundIn({ status: 'succeeded', submitted: true })).reference);

    const after = byQueue(await refunds.summary());
    for (const queue of REFUND_QUEUES) {
      expect(after[queue].count - before[queue].count, queue).toBe(made[queue].length);
      expect(after[queue].amount_pesewas - before[queue].amount_pesewas, queue).toBe(
        made[queue].length * 25_000,
      );
      const listed = (await refunds.list({ queue, limit: 200 })).rows.map((r) => r.reference);
      for (const reference of made[queue]) expect(listed, queue).toContain(reference);
      for (const other of REFUND_QUEUES.filter((q) => q !== queue)) {
        for (const reference of made[other]) expect(listed, queue).not.toContain(reference);
      }
    }
  });

  it('says who an instalment refund is owed to', async () => {
    const { reference, planId } = await refundIn({ method: 'manual' });
    const row = (await refunds.list({ queue: 'to_pay_by_hand', limit: 200 })).rows.find(
      (r) => r.reference === reference,
    )!;
    expect(row).toMatchObject({
      customer_plan_id: planId,
      customer_id: customerId,
      customer_name: 'Abena Owed',
      order_return_id: null,
      order_number: null,
      queue: 'to_pay_by_hand',
    });
  });

  it('marks a refund Paystack refused as paid by hand, and discharges what was owed', async () => {
    const { reference, planId } = await refundIn({ status: 'failed', submitted: true });
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(25_000);

    const settled = await refunds.settleManual(reference, STAFF, {
      note: 'MoMo transfer, ref 7781',
    });

    expect(settled.status).toBe('succeeded');
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
    const [event] = await db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, settled.id));
    expect(event).toMatchObject({
      event_type: 'refund.succeeded',
      from_state: 'failed',
      to_state: 'succeeded',
      actor_id: STAFF.actorId,
    });
    expect(event!.metadata).toMatchObject({
      note: 'MoMo transfer, ref 7781',
      paid_by_hand: true,
      paid_by_hand_after_provider_failure: true,
    });
    // The cash left outside Paystack, so it is booked out of the hand cash,
    // not out of what Paystack should be holding for us.
    const cash = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `refund-paid:${reference}`));
    expect(cash.find((e) => e.account_type === 'paystack_settlement')?.account_ref).toBe('manual');

    // A second hand payment is a second payment: refused, and nothing booked.
    await expect(
      refunds.settleManual(reference, STAFF, { note: 'paid again' }),
    ).rejects.toBeInstanceOf(RefundNotSettleableError);
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
  });

  it('marks a refund whose money came in outside Paystack as paid, with the note', async () => {
    const { reference, planId } = await refundIn({ method: 'manual' });
    await refunds.settleManual(reference, STAFF, { note: 'Cash at the Accra hub' });
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
  });

  it('will not mark paid a refund Paystack holds, one sent moments ago, or one never sent', async () => {
    for (const state of [
      { status: 'pending_confirmation' as const, submitted: true },
      // The reconciler found it at Paystack; the status has not caught up.
      { status: 'unknown' as const, submitted: true, paystackRefundId: '91003' },
      // Claimed seconds ago: the call to Paystack may still be out.
      { submitted: true, sentAgoMs: 5_000 },
      {},
    ]) {
      const { reference, planId } = await refundIn(state);
      // Not even with the attestation: Paystack is paying the first, and the
      // worker will send the second.
      await expect(
        refunds.settleManual(reference, STAFF, { note: 'paid', checkedPaystack: true }),
      ).rejects.toBeInstanceOf(RefundNotSettleableError);
      expect(await ledger.balanceOf('refund_payable', planId)).toBe(25_000);
    }
  });

  it('marks an unresolved refund paid only when someone checked Paystack and says how', async () => {
    for (const state of [
      { status: 'unknown' as const, submitted: true },
      // Claimed for sending, with nothing recorded after.
      { submitted: true },
    ]) {
      const { reference, planId } = await refundIn(state);
      await expect(refunds.settleManual(reference, STAFF)).rejects.toBeInstanceOf(
        RefundNotSettleableError,
      );
      await expect(
        refunds.settleManual(reference, STAFF, { note: 'Bank transfer 5521' }),
      ).rejects.toBeInstanceOf(RefundNotSettleableError);
      await expect(
        refunds.settleManual(reference, STAFF, { checkedPaystack: true }),
      ).rejects.toBeInstanceOf(RefundNotSettleableError);
      expect(await ledger.balanceOf('refund_payable', planId)).toBe(25_000);

      const settled = await refunds.settleManual(reference, STAFF, {
        note: 'Bank transfer 5521',
        checkedPaystack: true,
      });
      expect(settled.status).toBe('succeeded');
      expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
      const [event] = await db
        .select()
        .from(schema.audit_events)
        .where(eq(schema.audit_events.entity_id, settled.id));
      expect(event!.metadata).toMatchObject({
        note: 'Bank transfer 5521',
        checked_paystack_holds_no_refund: true,
      });
    }
  });

  it('raises Paystack reporting processed a refund recorded refused, rather than ignoring it', async () => {
    // Only a person paying it by hand may move a refused refund on. A late
    // "processed" means the record or Paystack is wrong, and someone may be
    // about to pay it by hand — so it is raised, not swallowed. A late
    // "failed" is a replay, and still a no-op.
    const { reference, planId } = await refundIn({ status: 'failed', submitted: true });
    await expect(refunds.confirmRefund(reference, 'succeeded')).rejects.toBeInstanceOf(
      RefundOutcomeConflictError,
    );
    expect((await refunds.confirmRefund(reference, 'failed')).status).toBe('failed');
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(25_000);
  });

  it('raises Paystack paying a refund a person already paid by hand', async () => {
    const { reference, planId } = await refundIn({ status: 'failed', submitted: true });
    await refunds.settleManual(reference, STAFF, { note: 'MoMo transfer' });
    await expect(refunds.confirmRefund(reference, 'succeeded')).rejects.toBeInstanceOf(
      RefundOutcomeConflictError,
    );
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);

    // One Paystack paid, reported twice, is just a replay.
    const sent = await refundIn({ status: 'pending_confirmation', submitted: true });
    await refunds.confirmRefund(sent.reference, 'succeeded');
    expect((await refunds.confirmRefund(sent.reference, 'succeeded')).status).toBe('succeeded');
  });

  it("does not let the worker's answer write over a refund settled while it was out", async () => {
    // Paystack's answer arrives after something else — here the webhook —
    // already settled the row. The worker used to write `pending_confirmation`
    // over `succeeded`, and the reconciler then failed on it every run.
    const { reference } = await refundIn({});
    const racing: RefundClient = {
      async refund() {
        await refunds.confirmRefund(reference, 'succeeded');
        return { data: { id: 'rf_77', status: 'pending' } };
      },
    };
    await new RefundService(db, ledger, audit, racing).disburse(reference);
    const [row] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.reference, reference));
    expect(row!.status).toBe('succeeded');
  });

  describe('reconciliation', () => {
    function reconciler(verifier: RefundVerifyClient) {
      const settlement = new SettlementService(db, ledger, audit, {
        async initiateTransfer() {
          throw new Error('not used');
        },
      });
      return new ReconciliationService(
        db,
        settlement,
        {
          async verifyTransfer() {
            throw new Error('not used');
          },
        },
        refunds,
        verifier,
      );
    }
    const row = async (reference: string) =>
      (await db.select().from(schema.refunds).where(eq(schema.refunds.reference, reference)))[0]!;

    it('moves a refund it finds at Paystack, still processing, into "With Paystack"', async () => {
      const { reference } = await refundIn({ status: 'unknown', submitted: true });
      const charge = (await row(reference)).provider_transaction_reference;
      const id = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
      // Paystack holds this refund on this row's charge, and nothing on any
      // other — earlier tests leave unresolved rows of their own in the sweep.
      await reconciler({
        async verifyRefund() {
          return { data: { status: 'processing' } };
        },
        async verifyTransaction(ref) {
          return { data: { id: ref === charge ? 7_700_001 : 7_700_999 } };
        },
        async listRefundsForTransaction(transactionId) {
          return {
            data: transactionId === '7700001' ? [{ id, amount: 25_000, status: 'processing' }] : [],
          };
        },
      }).reconcilePendingRefunds({ limit: 500 });

      const r = await row(reference);
      expect(r).toMatchObject({ status: 'pending_confirmation', paystack_refund_id: id });
      const listed = (await refunds.list({ queue: 'in_flight', limit: 200 })).rows;
      expect(listed.map((x) => x.reference)).toContain(reference);
      await expect(
        refunds.settleManual(reference, STAFF, { note: 'paid', checkedPaystack: true }),
      ).rejects.toBeInstanceOf(RefundNotSettleableError);
    });

    it('records why it could not resolve one, where the console shows it', async () => {
      const { reference } = await refundIn({ status: 'unknown', submitted: true });
      await reconciler({
        async verifyRefund() {
          throw new Error('not used');
        },
        async verifyTransaction() {
          return { data: { id: 7_700_002 } };
        },
        async listRefundsForTransaction() {
          return { data: [] };
        },
      }).reconcilePendingRefunds({ limit: 500 });

      const r = await row(reference);
      expect(r.status).toBe('unknown');
      expect(r.last_error).toMatch(/^Reconciler: .*no refund at Paystack/i);
    });
  });
});
