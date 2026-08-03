import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { LedgerService, type LedgerExecutor } from '../../shared/ledger/ledger.service';
import { PROVIDER_CASH_REF } from '../schedules/plan-cash-ledger';

const refunds = schema.refunds;
const attempts = schema.payment_attempts;

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

export class RefundNotFoundError extends Error {
  constructor(reference: string) {
    super(`Refund "${reference}" not found`);
    this.name = 'RefundNotFoundError';
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
      const result = await this.disburse(row.reference);
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
      // The call may or may not have reached Paystack. Park it as `unknown` and
      // leave the liability standing — reconciliation resolves it. Never assume
      // failure here: assuming failure and re-sending is how a customer gets
      // refunded twice.
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
    await this.db
      .update(refunds)
      .set({ status: 'pending_confirmation', paystack_refund_id: providerRefundId ?? null })
      .where(eq(refunds.id, row.id));
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
    opts: { providerRefundId?: string; error?: string; actor?: RefundActor } = {},
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
      if (row.status === 'succeeded' || row.status === 'failed') return row; // already terminal

      const nowIso = new Date().toISOString();
      if (outcome === 'succeeded') {
        await this.ledger.record(
          [
            {
              transactionId: `refund-paid:${reference}`,
              accountType: 'refund_payable',
              accountRef: row.customer_plan_id,
              direction: 'debit',
              amountPesewas: row.amount_pesewas,
              description: 'Refund returned to customer',
              metadata: { refund_reference: reference, schedule_id: row.schedule_id },
            },
            {
              transactionId: `refund-paid:${reference}`,
              accountType: 'paystack_settlement',
              accountRef: PROVIDER_CASH_REF,
              direction: 'credit',
              amountPesewas: row.amount_pesewas,
              description: 'Cash out for customer refund',
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
        metadata: { reference, amount_pesewas: row.amount_pesewas },
      });

      return updated;
    });
  }

  /**
   * Records that an out-of-band refund was physically returned — the cash a
   * field agent handed back, the bank transfer an operator made. Books the same
   * discharge a provider refund does; the difference is only who moved it.
   */
  async settleManual(reference: string, actor: RefundActor): Promise<Refund> {
    const row = (
      await this.db.select().from(refunds).where(eq(refunds.reference, reference)).limit(1)
    )[0];
    if (!row) throw new RefundNotFoundError(reference);
    if (row.method !== 'manual') {
      throw new RefundNotSettleableError(
        reference,
        'it is a provider refund — the worker settles it',
      );
    }
    return this.confirmRefund(reference, 'succeeded', { actor });
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
  private async markUnknown(row: Refund, error: string): Promise<void> {
    await this.db
      .update(refunds)
      .set({ status: 'unknown', last_error: error })
      .where(eq(refunds.id, row.id));
  }
}
