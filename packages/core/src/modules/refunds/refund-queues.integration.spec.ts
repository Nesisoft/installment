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
import {
  REFUND_QUEUES,
  RefundNotSettleableError,
  RefundService,
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
      ...(state.submitted ? { submitted_at: new Date().toISOString() } : {}),
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
      paid_by_hand_after_provider_failure: true,
    });

    // Once only: a second press finds it paid and books nothing.
    await refunds.settleManual(reference, STAFF);
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
  });

  it('marks a refund whose money came in outside Paystack as paid, with the note', async () => {
    const { reference, planId } = await refundIn({ method: 'manual' });
    await refunds.settleManual(reference, STAFF, { note: 'Cash at the Accra hub' });
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(0);
  });

  it('will not mark paid a refund Paystack accepted, or one never sent', async () => {
    for (const state of [{ status: 'pending_confirmation' as const, submitted: true }, {}]) {
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

  it('still treats a failed refund as final for the worker and the webhook', async () => {
    // Only a person paying it by hand may move a refused refund on. A late
    // "failed" or "processed" from Paystack must not.
    const { reference, planId } = await refundIn({ status: 'failed', submitted: true });
    const row = await refunds.confirmRefund(reference, 'succeeded');
    expect(row.status).toBe('failed');
    expect(await ledger.balanceOf('refund_payable', planId)).toBe(25_000);
  });
});
