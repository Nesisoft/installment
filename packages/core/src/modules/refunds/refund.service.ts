import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { LedgerService, type LedgerExecutor } from '../../shared/ledger/ledger.service';
import { MANUAL_CASH_REF, PROVIDER_CASH_REF } from '../schedules/plan-cash-ledger';
import { refundRejection, type ProviderRefundRef } from './provider-refund-rejection';

const refunds = schema.refunds;
const attempts = schema.payment_attempts;
const orders = schema.orders;
const plans = schema.customer_plans;
const returns = schema.order_returns;
const customers = schema.customers;
const ledgerEntries = schema.ledger_entries;

export type Refund = typeof schema.refunds.$inferSelect;

export type RefundStatus =
  | 'initiated'
  | 'pending_confirmation'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export type RefundMethod = 'paystack' | 'manual';

export interface RefundActor {
  actorId: string;
  actorType: AuditActorType;
}

/** The slice of the Paystack client the refund worker needs. */
export interface RefundClient {
  refund(req: {
    transaction: string;
    amount?: number;
    currency?: 'GHS';
    customer_note?: string;
    merchant_note?: string;
  }): Promise<{ data: { id: number | string; status: string } }>;
}

export interface RecordRefundIntentInput {
  customerPlanId: string;
  scheduleId: string;
  amountPesewas: number;
}

export interface RecordOrderReturnRefundInput {
  orderReturnId: string;
  orderId: string;
  amountPesewas: number;
}

export type DisburseOutcome =
  | 'succeeded'
  | 'pending_confirmation'
  | 'failed'
  | 'unknown'
  | 'skipped';

export interface DisburseResult {
  refundId: string;
  reference: string;
  outcome: DisburseOutcome;
  reason?: string;
}

export interface RefundSweepSummary {
  attempted: number;
  succeeded: number;
  pending: number;
  failed: number;
  unknown: number;
  results: DisburseResult[];
}

/**
 * Where a refund stands, from the point of view of the person who has to make
 * sure the customer gets their money:
 *
 * - `to_send` — waiting for the worker (or "Send now") to submit it to Paystack.
 * - `in_flight` — Paystack accepted it; the reconciler is waiting on the outcome.
 * - `unresolved` — sent, or possibly sent, with no answer we could act on. The
 *   reconciler keeps asking Paystack; nobody may send it again, because
 *   Paystack's refund API takes no client reference and a second send is a
 *   second refund.
 * - `failed` — Paystack refused it. The customer is still owed and has to be
 *   paid some other way, then marked paid by hand.
 * - `to_pay_by_hand` — the money came in outside Paystack, so it goes back the
 *   same way.
 * - `paid` — done.
 */
export const REFUND_QUEUES = [
  'to_send',
  'in_flight',
  'unresolved',
  'failed',
  'to_pay_by_hand',
  'paid',
] as const;
export type RefundQueue = (typeof REFUND_QUEUES)[number];

/**
 * The queue as SQL, so the list filter and the summary cannot disagree. A row
 * that has a Paystack refund id is in flight whatever its status says: the
 * reconciler found the refund at Paystack, and it is being paid.
 */
const QUEUE_SQL: SQL<RefundQueue> = sql<RefundQueue>`CASE
  WHEN ${refunds.status} = 'succeeded' THEN 'paid'
  WHEN ${refunds.status} = 'failed' THEN 'failed'
  WHEN ${refunds.status} = 'pending_confirmation' THEN 'in_flight'
  WHEN ${refunds.paystack_refund_id} IS NOT NULL THEN 'in_flight'
  WHEN ${refunds.status} = 'unknown' THEN 'unresolved'
  WHEN ${refunds.method} = 'manual' THEN 'to_pay_by_hand'
  WHEN ${refunds.submitted_at} IS NOT NULL THEN 'unresolved'
  ELSE 'to_send'
END`;

export interface RefundListRow {
  id: string;
  reference: string;
  amount_pesewas: number;
  method: RefundMethod;
  status: RefundStatus;
  queue: RefundQueue;
  last_error: string | null;
  /** The charge being refunded, as Paystack knows it — what to look up there. */
  provider_transaction_reference: string | null;
  paystack_refund_id: string | null;
  requested_at: string;
  submitted_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  /** An instalment refund's plan and row; null for an order return's. */
  customer_plan_id: string | null;
  schedule_id: string | null;
  /** An order return's; null for an instalment refund's. */
  order_return_id: string | null;
  order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
}

export interface RefundQueueTotal {
  queue: RefundQueue;
  count: number;
  amount_pesewas: number;
  /** The longest anyone in this queue has been waiting. */
  oldest_requested_at: string | null;
}

export interface ListRefundsInput {
  queue?: RefundQueue;
  limit?: number;
  offset?: number;
}

/** Query for GET /admin/refunds. Strings off the URL, coerced. */
export const listRefundsSchema = z.object({
  queue: z.enum(REFUND_QUEUES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Body for POST /admin/refunds/:reference/settle-manual. */
export const settleRefundManuallySchema = z.object({
  /** How it was paid: a transfer reference, a receipt number, who handed it over. */
  note: z.string().trim().min(1).max(300).optional(),
  /**
   * For an `unresolved` refund only: the person paying it by hand has looked
   * the charge up in the Paystack dashboard and it carries no refund.
   */
  checked_paystack: z.boolean().optional(),
});

export class RefundNotFoundError extends Error {
  constructor(reference: string) {
    super(`Refund "${reference}" not found`);
    this.name = 'RefundNotFoundError';
  }
}

/**
 * Paystack reports a refund processed that our records say was refused, or
 * was already paid by hand. Either the customer has been paid twice, or the
 * record is wrong; nothing automatic may resolve it, and a person must look.
 */
export class RefundOutcomeConflictError extends Error {
  constructor(reference: string, detail: string) {
    super(`Refund "${reference}": ${detail}`);
    this.name = 'RefundOutcomeConflictError';
  }
}

export class RefundNotSettleableError extends Error {
  constructor(reference: string, detail: string) {
    super(`Refund "${reference}" cannot be settled: ${detail}`);
    this.name = 'RefundNotSettleableError';
  }
}

/** Our own identifier for the refund. Paystack's API takes no client reference. */
export function refundReference(scheduleId: string): string {
  return `RFND-${scheduleId}`;
}

/**
 * Returns refunded money to the customer.
 *
 * The books already said we owed it: refunding an installment credits
 * `refund_payable` (migration 0008) and reverses the merchant accrual. Nothing
 * discharged that liability, and `PaystackClient` had no refund method at all,
 * so the console's refund button produced a complete set of books describing a
 * payment the customer never received.
 *
 * The provider call is deliberately outside the refund transaction, in the same
 * shape as {@link SettlementService}: the intent row commits with the state
 * flip, and a worker sends it. A provider outage therefore delays a refund
 * rather than losing it, and no HTTP call is ever held open inside a database
 * transaction.
 *
 * Ledger discharge, on success:
 *
 *   DEBIT  refund_payable[plan]          amount   (the obligation is settled)
 *   CREDIT paystack_settlement['main']   amount   (cash leaves the platform)
 */
export class RefundService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogger,
    private readonly client?: RefundClient,
  ) {}

  /**
   * Records the obligation. Called inside the refund's own transaction so the
   * row cannot exist without the schedule flip, or the flip without the row.
   *
   * Idempotent on `schedule_id` (a UNIQUE constraint backs it): `refunded` is
   * terminal in the schedule state machine, so a second call is a replay.
   */
  async recordIntent(input: RecordRefundIntentInput, tx: LedgerExecutor): Promise<void> {
    if (input.amountPesewas <= 0) return;

    // What was actually charged, and by whom. `installment_schedule.
    // provider_reference` is not enough on its own — a manual payment stores
    // whatever string the admin typed there — so ask the attempt that settled
    // it. No succeeded Paystack attempt means the money came in out of band and
    // has to go back the same way.
    const settledBy = (
      await tx
        .select({ reference: attempts.provider_reference })
        .from(attempts)
        .where(
          and(
            eq(attempts.schedule_id, input.scheduleId),
            eq(attempts.provider, 'paystack'),
            eq(attempts.status, 'succeeded'),
          ),
        )
        .orderBy(desc(attempts.initiated_at))
        .limit(1)
    )[0];

    const transactionReference = settledBy?.reference ?? null;
    // Marking this at intent time keeps the disbursement sweep from retrying
    // forever against something Paystack can never settle.
    const method: RefundMethod = transactionReference ? 'paystack' : 'manual';

    await tx
      .insert(refunds)
      .values({
        customer_plan_id: input.customerPlanId,
        schedule_id: input.scheduleId,
        amount_pesewas: input.amountPesewas,
        reference: refundReference(input.scheduleId),
        method,
        provider_transaction_reference: transactionReference,
        status: 'initiated',
      })
      .onConflictDoNothing();
  }

  /**
   * The obligation to pay a buyer back for a returned order.
   *
   * The sibling of {@link recordIntent}, and the reason 0020 relaxed
   * `refunds.customer_plan_id` and `schedule_id` to nullable: both were NOT
   * NULL, so every row in this table was a refund of one instalment on one
   * credit plan and an outright purchase — which is most of them — had no way
   * to be refunded at all. The engine, the disbursement sweep and the
   * reconciliation path were all real and all unreachable for those orders.
   *
   * Everything downstream is unchanged. `disburse` refunds against
   * `provider_transaction_reference`, which for an order is the reference the
   * charge settled under, and the sweep does not care which owner a row has.
   */
  async recordOrderReturnIntent(
    input: RecordOrderReturnRefundInput,
    tx: LedgerExecutor,
  ): Promise<void> {
    if (input.amountPesewas <= 0) return;

    // What the buyer actually paid with. `orders.payment_reference` is written
    // by the charge that settled the order, and its absence means the money
    // came in out of band — a manual transfer, or a fixture — so it has to go
    // back the same way rather than being submitted to Paystack forever.
    const paidBy = (
      await tx
        .select({
          reference: orders.payment_reference,
          paidVia: sql<string | null>`${orders.metadata} ->> 'paid_via'`,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1)
    )[0];

    // A reference staff typed in for a bank transfer or cash is not a charge
    // Paystack can refund.
    const transactionReference =
      paidBy?.paidVia === 'outside_paystack' ? null : (paidBy?.reference ?? null);
    const method: RefundMethod = transactionReference ? 'paystack' : 'manual';

    await tx
      .insert(refunds)
      .values({
        order_return_id: input.orderReturnId,
        amount_pesewas: input.amountPesewas,
        reference: `refund:return:${input.orderReturnId}`,
        method,
        provider_transaction_reference: transactionReference,
        status: 'initiated',
      })
      .onConflictDoNothing();
  }

  /** Refunds awaiting submission to the provider, oldest first. */
  async findUnsent(limit = 50): Promise<Refund[]> {
    return this.db
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'initiated'),
          eq(refunds.method, 'paystack'),
          isNull(refunds.submitted_at),
        ),
      )
      .orderBy(asc(refunds.requested_at))
      .limit(limit);
  }

  /** Submits every unsent refund to the provider. */
  async runSweep(limit = 50): Promise<RefundSweepSummary> {
    const summary: RefundSweepSummary = {
      attempted: 0,
      succeeded: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
      results: [],
    };

    for (const row of await this.findUnsent(limit)) {
      // Per-item isolation. `disburse` wraps the provider call, but everything
      // after it — confirmRefund, markUnknown, the pending write — takes a
      // FOR UPDATE lock and posts to the ledger, so it can throw. Letting that
      // escape ended the sweep for every refund behind this one, and the cron
      // runs both halves under one try, so it also skipped the reconciliation
      // pass that would have healed them.
      let result: DisburseResult;
      try {
        result = await this.disburse(row.reference);
      } catch (err) {
        // `unknown` is the accurate bucket: the provider call may well have
        // succeeded, so this must never be re-sent blindly. The cron already
        // alerts on it.
        result = {
          refundId: row.id,
          reference: row.reference,
          outcome: 'unknown',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (result.outcome === 'skipped') continue;
      summary.attempted += 1;
      summary.results.push(result);
      if (result.outcome === 'succeeded') summary.succeeded += 1;
      else if (result.outcome === 'pending_confirmation') summary.pending += 1;
      else if (result.outcome === 'failed') summary.failed += 1;
      else summary.unknown += 1;
    }

    return summary;
  }

  /**
   * Sends one refund to the provider and applies the outcome.
   *
   * The row is claimed under a lock before the call, so two workers cannot both
   * submit it — Paystack's refund API has no client reference, which means a
   * duplicate submission is a duplicate refund with no way to detect it after
   * the fact.
   */
  async disburse(reference: string): Promise<DisburseResult> {
    const claimed = await this.claimForSubmission(reference);
    if (!claimed.ok) {
      return { refundId: claimed.id, reference, outcome: 'skipped', reason: claimed.reason };
    }
    const row = claimed.row;

    if (!this.client) {
      await this.markUnknown(row, 'no refund client configured');
      return {
        refundId: row.id,
        reference,
        outcome: 'unknown',
        reason: 'no refund client configured',
      };
    }

    let status: string;
    let providerRefundId: string | undefined;
    try {
      const res = await this.client.refund({
        transaction: row.provider_transaction_reference!,
        amount: row.amount_pesewas,
        currency: 'GHS',
        merchant_note: `Refund for installment ${row.schedule_id}`,
      });
      status = (res.data?.status ?? '').toLowerCase();
      providerRefundId = res.data?.id !== undefined ? String(res.data.id) : undefined;
    } catch (err) {
      // Paystack answered, and declined. A validation refusal means no refund
      // was created: say so, with Paystack's words — the liability stays
      // standing either way, but `unknown` claimed we did not know.
      const rejection = refundRejection(err);
      if (rejection?.kind === 'refused') {
        await this.confirmRefund(reference, 'failed', { error: rejection.message });
        return { refundId: row.id, reference, outcome: 'failed', reason: rejection.message };
      }
      // "A refund already exists": take that one on if it is unmistakably
      // this refund, so the reconciler can follow it instead of a person.
      if (rejection?.kind === 'exists') {
        const match = await this.matchProviderRefund(row, rejection.existing);
        if (match) return this.takeOnProviderRefund(row, match);
        await this.markUnknown(row, rejection.message);
        return { refundId: row.id, reference, outcome: 'unknown', reason: rejection.message };
      }
      // Otherwise the call may or may not have reached Paystack. Park it as
      // `unknown` and leave the liability standing — reconciliation resolves
      // it. Never assume failure here: assuming failure and re-sending is how
      // a customer gets refunded twice.
      const message = err instanceof Error ? err.message : String(err);
      await this.markUnknown(row, message);
      return { refundId: row.id, reference, outcome: 'unknown', reason: message };
    }

    if (status === 'processed' || status === 'success') {
      await this.confirmRefund(reference, 'succeeded', { providerRefundId });
      return { refundId: row.id, reference, outcome: 'succeeded' };
    }
    if (status === 'failed') {
      await this.confirmRefund(reference, 'failed', {
        providerRefundId,
        error: 'provider rejected the refund',
      });
      return { refundId: row.id, reference, outcome: 'failed', reason: 'provider rejected' };
    }

    // pending / processing — accepted, outcome not yet known.
    // Only from where the claim left it: a person may have settled the row
    // while the call was out, and that must not be written over.
    await this.db
      .update(refunds)
      .set({ status: 'pending_confirmation', paystack_refund_id: providerRefundId ?? null })
      .where(and(eq(refunds.id, row.id), eq(refunds.status, 'initiated')));
    return {
      refundId: row.id,
      reference,
      outcome: 'pending_confirmation',
      reason: status || 'pending',
    };
  }

  /**
   * Drives a refund to a terminal state and moves the money on the books.
   *
   * Terminal and idempotent: the row is read `FOR UPDATE` inside the
   * transaction, so a webhook racing the reconciliation sweep cannot discharge
   * `refund_payable` twice on an append-only ledger.
   */
  async confirmRefund(
    reference: string,
    outcome: 'succeeded' | 'failed',
    opts: {
      providerRefundId?: string;
      error?: string;
      actor?: RefundActor;
      /**
       * A person paid it by hand (see {@link settleManual}). Whether that is
       * allowed is decided here, under the row lock, against the status the
       * row has now — not the one it had when they pressed the button.
       */
      byHand?: { note?: string; checkedPaystack?: boolean };
    } = {},
  ): Promise<Refund> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx
          .select()
          .from(refunds)
          .where(eq(refunds.reference, reference))
          .for('update')
          .limit(1)
      )[0];
      if (!row) throw new RefundNotFoundError(reference);
      if (opts.byHand) {
        // A second hand payment is a second payment: say so, rather than
        // answering 200 and dropping how it was paid. (A retry of the same
        // request is answered from the Idempotency-Key cache, not here.)
        if (row.status === 'succeeded') {
          throw new RefundNotSettleableError(
            reference,
            `it is already paid — recorded ${row.succeeded_at ?? 'earlier'}`,
          );
        }
        const refusal = handPaymentRefusal(row, opts.byHand);
        if (refusal) throw new RefundNotSettleableError(reference, refusal);
      } else if (row.status === 'succeeded' || row.status === 'failed') {
        // Terminal. Paystack saying "processed" about one we recorded as
        // refused, or that a person already paid by hand, is not a replay —
        // it may be the customer paid twice — so it is raised, not swallowed.
        if (outcome === 'succeeded') {
          if (row.status === 'failed') {
            throw new RefundOutcomeConflictError(
              reference,
              'Paystack reports it processed, but it is recorded as refused — check it before anyone pays it by hand',
            );
          }
          if (await this.wasPaidByHand(reference, tx)) {
            throw new RefundOutcomeConflictError(
              reference,
              'Paystack reports it processed, but it was already paid by hand — the customer may have been paid twice',
            );
          }
        }
        return row;
      }

      const nowIso = new Date().toISOString();
      if (outcome === 'succeeded') {
        await this.ledger.record(
          [
            {
              transactionId: `refund-paid:${reference}`,
              accountType: 'refund_payable',
              // The plan for an instalment refund, the return for an order one
              // — whichever owns this row. It has to be the same ref the
              // liability was credited under, or discharging it would drive a
              // balance nobody credited negative.
              accountRef: refundPayableRef(row),
              direction: 'debit',
              amountPesewas: row.amount_pesewas,
              description: 'Refund returned to customer',
              metadata: {
                refund_reference: reference,
                schedule_id: row.schedule_id,
                order_return_id: row.order_return_id,
              },
            },
            {
              transactionId: `refund-paid:${reference}`,
              accountType: 'paystack_settlement',
              // Paid by hand, the cash never left Paystack: booking it out of
              // 'main' would make that account stop meaning "what Paystack
              // should hold for us", which is what it exists to mean.
              accountRef: opts.byHand ? MANUAL_CASH_REF : PROVIDER_CASH_REF,
              direction: 'credit',
              amountPesewas: row.amount_pesewas,
              description: opts.byHand
                ? 'Cash out for customer refund, paid by hand'
                : 'Cash out for customer refund',
              metadata: { refund_reference: reference, schedule_id: row.schedule_id },
            },
          ],
          tx,
        );
      }

      const [updated] = await tx
        .update(refunds)
        .set({
          status: outcome,
          paystack_refund_id: opts.providerRefundId ?? row.paystack_refund_id,
          last_error: outcome === 'failed' ? (opts.error ?? 'refund failed') : null,
          ...(outcome === 'succeeded' ? { succeeded_at: nowIso } : { failed_at: nowIso }),
        })
        .where(eq(refunds.id, row.id))
        .returning();
      if (!updated) throw new Error('refunds update returned no row');

      await this.audit.append(tx, {
        entityType: 'refund',
        entityId: row.id,
        eventType: `refund.${outcome}`,
        fromState: row.status,
        toState: outcome,
        actorId: opts.actor?.actorId ?? 'system',
        actorType: opts.actor?.actorType ?? 'system',
        reason: opts.error,
        metadata: {
          reference,
          amount_pesewas: row.amount_pesewas,
          ...(opts.byHand
            ? {
                paid_by_hand: true,
                ...(opts.byHand.note ? { note: opts.byHand.note } : {}),
                ...(row.status === 'failed' ? { paid_by_hand_after_provider_failure: true } : {}),
                ...(row.method === 'paystack' && row.status !== 'failed'
                  ? { checked_paystack_holds_no_refund: true }
                  : {}),
              }
            : {}),
        },
      });

      return updated;
    });
  }

  /**
   * Records that a refund was physically returned by hand — the cash a field
   * agent handed back, the bank transfer an operator made. Books the same
   * discharge a provider refund does; the difference is only who moved it.
   *
   * Two kinds of refund are paid this way. One whose money came in outside
   * Paystack goes back outside it. And one Paystack refused: that used to be
   * final, with the customer still owed and nothing in the system able to
   * record paying them, so the liability stood on the books for good.
   *
   * Never a refund Paystack accepted and is still processing (`in_flight`):
   * paying that by hand as well pays the customer twice. An `unresolved` one —
   * sent, or possibly sent, with no answer — only when the person paying it has
   * looked the charge up in the Paystack dashboard and found no refund on it,
   * says so (`checkedPaystack`), and says how they paid. The reconciler parks
   * such a refund for good when Paystack holds nothing for the charge, and
   * nothing else could ever pay it.
   */
  async settleManual(
    reference: string,
    actor: RefundActor,
    opts: { note?: string; checkedPaystack?: boolean } = {},
  ): Promise<Refund> {
    return this.confirmRefund(reference, 'succeeded', { actor, byHand: opts });
  }

  /**
   * Refunds across every plan and return, newest first, with who they are for.
   * The console's refunds page; `queue` narrows it to one kind of work.
   */
  async list(input: ListRefundsInput = {}): Promise<{ rows: RefundListRow[]; total: number }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const where = input.queue ? sql`${QUEUE_SQL} = ${input.queue}` : undefined;

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(refunds)
      .where(where);

    const rows = await this.db
      .select({
        id: refunds.id,
        reference: refunds.reference,
        amount_pesewas: refunds.amount_pesewas,
        method: refunds.method,
        status: refunds.status,
        queue: QUEUE_SQL,
        last_error: refunds.last_error,
        provider_transaction_reference: refunds.provider_transaction_reference,
        paystack_refund_id: refunds.paystack_refund_id,
        requested_at: refunds.requested_at,
        submitted_at: refunds.submitted_at,
        succeeded_at: refunds.succeeded_at,
        failed_at: refunds.failed_at,
        customer_plan_id: refunds.customer_plan_id,
        schedule_id: refunds.schedule_id,
        order_return_id: refunds.order_return_id,
        order_id: returns.order_id,
        order_number: orders.order_number,
        customer_id: sql<string | null>`coalesce(${plans.customer_id}, ${returns.customer_id})`,
        customer_name: sql<
          string | null
        >`nullif(trim(concat(${customers.first_name}, ' ', ${customers.last_name})), '')`,
      })
      .from(refunds)
      .leftJoin(plans, eq(plans.id, refunds.customer_plan_id))
      .leftJoin(returns, eq(returns.id, refunds.order_return_id))
      .leftJoin(orders, eq(orders.id, returns.order_id))
      .leftJoin(
        customers,
        sql`${customers.id} = coalesce(${plans.customer_id}, ${returns.customer_id})`,
      )
      .where(where)
      .orderBy(desc(refunds.requested_at), desc(refunds.id))
      .limit(limit)
      .offset(offset);

    return {
      rows: rows.map((r) => ({
        ...r,
        method: r.method as RefundMethod,
        status: r.status as RefundStatus,
      })),
      total,
    };
  }

  /** Every queue, with how many refunds and how much money is in it. */
  async summary(): Promise<RefundQueueTotal[]> {
    const rows = await this.db
      .select({
        queue: QUEUE_SQL,
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${refunds.amount_pesewas}), 0)::text`,
        oldest: sql<string | null>`min(${refunds.requested_at})`,
      })
      .from(refunds)
      .groupBy(QUEUE_SQL);
    const byQueue = new Map(rows.map((r) => [r.queue, r]));
    return REFUND_QUEUES.map((queue) => {
      const r = byQueue.get(queue);
      return {
        queue,
        count: r?.count ?? 0,
        amount_pesewas: Number(r?.amount ?? 0),
        oldest_requested_at: r?.oldest ?? null,
      };
    });
  }

  /** Refunds for one plan, newest first — the console's "what do we owe" view. */
  async listForPlan(customerPlanId: string): Promise<Refund[]> {
    return this.db
      .select()
      .from(refunds)
      .where(eq(refunds.customer_plan_id, customerPlanId))
      .orderBy(asc(refunds.requested_at));
  }

  async findByReference(reference: string): Promise<Refund | undefined> {
    return (
      await this.db.select().from(refunds).where(eq(refunds.reference, reference)).limit(1)
    )[0];
  }

  /**
   * Finds the refund for an original charge. A refund webhook names the
   * transaction that was refunded, never our record, so this is the only link
   * back from an inbound refund event.
   */
  async findByProviderTransactionReference(
    transactionReference: string,
  ): Promise<Refund | undefined> {
    return (
      await this.db
        .select()
        .from(refunds)
        .where(eq(refunds.provider_transaction_reference, transactionReference))
        .orderBy(desc(refunds.requested_at))
        .limit(1)
    )[0];
  }

  /**
   * Takes the row for submission, refusing if another worker got there first.
   * `submitted_at` doubles as the claim: the conditional UPDATE only matches a
   * row that has not yet been sent.
   */
  private async claimForSubmission(
    reference: string,
  ): Promise<{ ok: true; row: Refund } | { ok: false; id: string; reason: string }> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx
          .select()
          .from(refunds)
          .where(eq(refunds.reference, reference))
          .for('update')
          .limit(1)
      )[0];
      if (!row) throw new RefundNotFoundError(reference);
      if (row.status !== 'initiated') {
        return { ok: false as const, id: row.id, reason: `already ${row.status}` };
      }
      if (row.method !== 'paystack' || !row.provider_transaction_reference) {
        return { ok: false as const, id: row.id, reason: 'manual refund — settled by hand' };
      }
      if (row.submitted_at) {
        return { ok: false as const, id: row.id, reason: 'already submitted' };
      }

      const [claimed] = await tx
        .update(refunds)
        .set({ submitted_at: new Date().toISOString() })
        .where(eq(refunds.id, row.id))
        .returning();
      return { ok: true as const, row: claimed! };
    });
  }

  /** Parks a refund whose provider call gave no usable answer. */
  /**
   * The one refund at Paystack that is this row, if there is exactly one.
   *
   * Same amount, and not already the provider refund of another of our rows —
   * two equal refunds of one charge are two refunds, and adopting a refund
   * some other row accounts for would book one payment out twice.
   */
  async matchProviderRefund(
    row: Refund,
    candidates: ProviderRefundRef[],
  ): Promise<ProviderRefundRef | null> {
    const sameAmount = candidates.filter((c) => c.amount === row.amount_pesewas);
    if (sameAmount.length !== 1) return null;
    const candidate = sameAmount[0]!;
    const claimed = await this.db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.paystack_refund_id, candidate.id), ne(refunds.id, row.id)))
      .limit(1);
    return claimed[0] ? null : candidate;
  }

  /** Records `provider` as this row's refund at Paystack and applies its status. */
  async takeOnProviderRefund(row: Refund, provider: ProviderRefundRef): Promise<DisburseResult> {
    const status = (provider.status ?? '').toLowerCase();
    if (status === 'processed' || status === 'success') {
      await this.confirmRefund(row.reference, 'succeeded', { providerRefundId: provider.id });
      return { refundId: row.id, reference: row.reference, outcome: 'succeeded' };
    }
    if (status === 'failed') {
      await this.confirmRefund(row.reference, 'failed', {
        providerRefundId: provider.id,
        error: 'provider reported the refund failed',
      });
      return {
        refundId: row.id,
        reference: row.reference,
        outcome: 'failed',
        reason: 'provider rejected',
      };
    }
    await this.db
      .update(refunds)
      .set({ status: 'pending_confirmation', paystack_refund_id: provider.id })
      .where(and(eq(refunds.id, row.id), eq(refunds.status, 'initiated')));
    return {
      refundId: row.id,
      reference: row.reference,
      outcome: 'pending_confirmation',
      reason: status || 'pending',
    };
  }

  private async markUnknown(row: Refund, error: string): Promise<void> {
    await this.db
      .update(refunds)
      .set({ status: 'unknown', last_error: error })
      .where(and(eq(refunds.id, row.id), eq(refunds.status, 'initiated')));
  }

  /** Whether a person paid this refund by hand: its cash left outside Paystack. */
  private async wasPaidByHand(reference: string, tx: LedgerExecutor): Promise<boolean> {
    const [hit] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.transaction_id, `refund-paid:${reference}`),
          eq(ledgerEntries.account_type, 'paystack_settlement'),
          eq(ledgerEntries.account_ref, MANUAL_CASH_REF),
        ),
      )
      .limit(1);
    return Boolean(hit);
  }
}

/**
 * The account a refund's liability sits under.
 *
 * `refunds` gained a second owner in 0020: a row belongs to a schedule (an
 * instalment being given back) or to an order return, and the CHECK guarantees
 * exactly one. The liability is credited under that owner's id and has to be
 * discharged under the same one.
 */
function refundPayableRef(row: Refund): string {
  const ref = row.customer_plan_id ?? row.order_return_id;
  if (!ref) throw new Error(`Refund ${row.reference} has neither a plan nor a return`);
  return ref;
}

/**
 * Why this refund may not be marked paid by hand right now, or null if it may.
 * See {@link RefundService.settleManual}.
 */
function handPaymentRefusal(
  row: Refund,
  opts: { note?: string; checkedPaystack?: boolean },
): string | null {
  // The money came in outside Paystack, or Paystack refused to send it back:
  // either way nothing but a person will pay it.
  if (row.method === 'manual' || row.status === 'failed') return null;
  if (row.status === 'initiated' && !row.submitted_at) {
    return 'it has not been sent to Paystack yet — send it, or wait for the worker';
  }
  if (row.status === 'pending_confirmation' || row.paystack_refund_id) {
    return 'Paystack holds a refund for it and is still processing it — paying it by hand as well would pay the customer twice';
  }
  // Claimed for sending moments ago: the call may still be out. Give it well
  // past the client's timeout before anyone may decide it went nowhere.
  if (row.status === 'initiated' && row.submitted_at) {
    const sentAt = parseTimestamp(row.submitted_at);
    if (sentAt === null || Date.now() - sentAt < SEND_SETTLE_MS) {
      return 'it was sent to Paystack moments ago — wait a few minutes for the answer';
    }
  }
  // `unknown`, or claimed for sending with nothing recorded after.
  if (!opts.checkedPaystack || !opts.note) {
    return 'it may have reached Paystack — look the charge up in the Paystack dashboard first, and only if it carries no refund, pay it by hand and say so, with how you paid';
  }
  return null;
}

/** How long a just-claimed refund is left alone: comfortably past the 15s client timeout. */
const SEND_SETTLE_MS = 2 * 60_000;

/** A `timestamptz` string as Postgres hands it back, in milliseconds. */
function parseTimestamp(value: string): number | null {
  const ms = Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(ms) ? null : ms;
}
