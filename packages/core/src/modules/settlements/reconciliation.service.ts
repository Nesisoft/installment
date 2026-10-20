import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { SettlementService, type PayoutStatus } from './settlement.service';
import type { Refund, RefundService, RefundStatus } from '../refunds/refund.service';
import { toRef } from '../refunds/provider-refund-rejection';

const payouts = schema.payouts;
const refunds = schema.refunds;

/** Statuses that are not yet terminal and need a verify sweep. */
const RECONCILABLE_STATUSES = ['pending_confirmation', 'unknown'] as const;

/** The slice of the Paystack client the reconciler needs. */
export interface TransferVerifyClient {
  verifyTransfer(reference: string): Promise<{ data: { status: string; transfer_code?: string } }>;
}

/**
 * The refund side of the same job. Paystack refunds are verified by the id
 * Paystack returned, not by a reference of ours — a refund we never got an id
 * for cannot be verified at all, which is why an `unknown` refund without one
 * stays `unresolved` rather than being assumed failed.
 */
export interface RefundVerifyClient {
  verifyRefund(refundId: string): Promise<{ data: { status: string } }>;
  /**
   * Both optional, and used together, to find the refund behind a row that
   * never learnt its provider id. `verifyTransaction` turns the charge
   * reference into Paystack's numeric transaction id; the refund list is only
   * searchable by that id — by reference it answers an empty list, which
   * would read as "no refund exists" and invite a second one.
   */
  verifyTransaction?(reference: string): Promise<{ data: { id?: number | string } }>;
  listRefundsForTransaction?(
    transactionId: string,
  ): Promise<{ data: Array<{ id: number | string; amount?: number; status?: string }> }>;
}

export interface RefundReconciliationResult {
  refundId: string;
  reference: string;
  from: RefundStatus;
  outcome: ReconciliationOutcome;
  reason?: string;
}

export interface RefundReconciliationSummary {
  checked: number;
  settled: number;
  failed: number;
  stillPending: number;
  unresolved: number;
  results: RefundReconciliationResult[];
}

export type ReconciliationOutcome = 'settled' | 'failed' | 'still_pending' | 'unresolved';

export interface ReconciliationResult {
  payoutId: string;
  reference: string;
  from: PayoutStatus;
  outcome: ReconciliationOutcome;
  reason?: string;
}

export interface ReconciliationSummary {
  checked: number;
  settled: number;
  failed: number;
  stillPending: number;
  unresolved: number;
  results: ReconciliationResult[];
}

/** A not-found (HTTP 404) error from the verify call. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: number }).status === 404
  );
}

/**
 * Resolves payouts left in-flight by the settlement worker — `pending_confirmation`
 * (transfer accepted, awaiting outcome) and `unknown` (the initiate call errored,
 * so we don't yet know if Paystack received it).
 *
 * Each payout is verified against Paystack and driven to a terminal state via
 * {@link SettlementService.confirmPayout} (which owns the ledger reversal):
 *
 *   - verify → success            → settled
 *   - verify → failed / reversed  → failed (payable restored)
 *   - verify → pending / otp      → left for the next sweep
 *   - verify → 404 on an `unknown` payout → the transfer was never created, so
 *     it's safe to fail + reverse. A 404 on a `pending_confirmation` payout
 *     (which has a transfer code) is treated as transient and left alone.
 *   - any other error             → left for the next sweep (never auto-reverses)
 */
export class ReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly settlement: SettlementService,
    private readonly verifier: TransferVerifyClient,
    /** Wired together so one sweep resolves both directions of in-flight money. */
    private readonly refundService?: RefundService,
    private readonly refundVerifier?: RefundVerifyClient,
  ) {}

  async reconcilePendingPayouts(opts: { limit?: number } = {}): Promise<ReconciliationSummary> {
    const stale = await this.db
      .select()
      .from(payouts)
      .where(inArray(payouts.status, [...RECONCILABLE_STATUSES]))
      .orderBy(asc(payouts.initiated_at))
      .limit(opts.limit ?? 100);

    const summary: ReconciliationSummary = {
      checked: 0,
      settled: 0,
      failed: 0,
      stillPending: 0,
      unresolved: 0,
      results: [],
    };

    for (const payout of stale) {
      // Structural backstop. reconcileOne is written not to throw, but the
      // loop must not depend on that: one unreconciled payout is money in
      // flight, and killing the sweep leaves every payout behind it in flight
      // too.
      let result: ReconciliationResult;
      try {
        result = await this.reconcileOne({
          id: payout.id,
          reference: payout.reference,
          status: payout.status as PayoutStatus,
          lastError: payout.last_error,
        });
      } catch (err) {
        result = {
          payoutId: payout.id,
          reference: payout.reference,
          from: payout.status as PayoutStatus,
          outcome: 'unresolved',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      summary.checked += 1;
      summary.results.push(result);
      if (result.outcome === 'settled') summary.settled += 1;
      else if (result.outcome === 'failed') summary.failed += 1;
      else if (result.outcome === 'still_pending') summary.stillPending += 1;
      else summary.unresolved += 1;
    }

    return summary;
  }

  /** Verifies and resolves one payout. Never throws — verify errors become `unresolved`. */
  async reconcileOne(payout: {
    id: string;
    reference: string;
    status: PayoutStatus;
    /** Why initiating the transfer failed, if it did — kept on reversal. */
    lastError?: string | null;
  }): Promise<ReconciliationResult> {
    const base = { payoutId: payout.id, reference: payout.reference, from: payout.status };

    let status: string;
    try {
      const res = await this.verifier.verifyTransfer(payout.reference);
      status = (res.data.status ?? '').toLowerCase();
    } catch (err) {
      // A definitive not-found on an `unknown` payout means the transfer never
      // reached Paystack — safe to reverse. Everything else is transient.
      if (isNotFound(err) && payout.status === 'unknown') {
        // Keep why initiating it failed. On its own "not found" is true and
        // no help to anyone asking why a merchant was not paid — the cause is
        // usually Paystack's own refusal, e.g. payouts not enabled on the
        // account.
        const error = payout.lastError
          ? `transfer not found at Paystack — initiating it failed: ${payout.lastError}`
          : 'transfer not found at Paystack';
        return this.resolve(base, 'failed', 'not found at Paystack', () =>
          this.settlement.confirmPayout(payout.reference, 'failed', { error }),
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, outcome: 'unresolved', reason: message };
    }

    if (status === 'success') {
      return this.resolve(base, 'settled', undefined, () =>
        this.settlement.confirmPayout(payout.reference, 'settled'),
      );
    }
    if (status === 'failed' || status === 'reversed') {
      return this.resolve(base, 'failed', `transfer ${status}`, () =>
        this.settlement.confirmPayout(payout.reference, status, {
          error: `transfer ${status}`,
        }),
      );
    }
    // pending / otp / ongoing → not terminal yet.
    return { ...base, outcome: 'still_pending', reason: status || 'pending' };
  }

  /**
   * Applies a terminal outcome, turning a failure to apply it into
   * `unresolved` rather than a throw.
   *
   * The verify call was already wrapped; the write side was not, and it can
   * throw just as readily — `confirmPayout` opens a transaction and takes a
   * FOR UPDATE lock, so a lock timeout or serialization failure surfaces here,
   * and a missing row raises PayoutNotFoundError. `unresolved` is the right
   * bucket: the payout is untouched, so the next sweep retries it.
   */
  private async resolve(
    base: Omit<ReconciliationResult, 'outcome' | 'reason'>,
    outcome: 'settled' | 'failed',
    reason: string | undefined,
    apply: () => Promise<void>,
  ): Promise<ReconciliationResult> {
    try {
      await apply();
      return { ...base, outcome, ...(reason ? { reason } : {}) };
    } catch (err) {
      return {
        ...base,
        outcome: 'unresolved',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Resolves refunds the disbursement worker left in-flight, the mirror of
   * {@link reconcilePendingPayouts} for money going back to customers.
   *
   * A refund is verified by the id Paystack returned. An `unknown` refund with
   * no id was never confirmed to have been created — it can neither be verified
   * nor safely re-sent, because Paystack's refund API takes no client reference
   * and would happily create a second one. Those stay `unresolved` and surface
   * for a human, which is the honest outcome.
   */
  async reconcilePendingRefunds(
    opts: { limit?: number } = {},
  ): Promise<RefundReconciliationSummary> {
    const summary: RefundReconciliationSummary = {
      checked: 0,
      settled: 0,
      failed: 0,
      stillPending: 0,
      unresolved: 0,
      results: [],
    };
    if (!this.refundService || !this.refundVerifier) return summary;

    const stale = await this.db
      .select()
      .from(refunds)
      .where(
        or(
          inArray(refunds.status, [...RECONCILABLE_STATUSES]),
          // Claimed but never resolved. `claimForSubmission` stamps
          // `submitted_at` and leaves the status at `initiated`; if the write
          // after the provider call then throws, the row sits in a gap between
          // the two queues — `findUnsent` skips it because `submitted_at` is
          // set, and this sweep used to skip it because the status is not
          // `pending_confirmation` or `unknown`. A refund submitted to Paystack
          // that nothing will ever look at again is the worst of the three
          // states, so claim it here. Without a provider refund id it resolves
          // to `unresolved`, which is honest: it cannot be verified and must
          // not be re-sent, and the cron alerts on it.
          and(eq(refunds.status, 'initiated'), isNotNull(refunds.submitted_at)),
        ),
      )
      .orderBy(asc(refunds.requested_at))
      .limit(opts.limit ?? 100);

    for (const row of stale) {
      const base = {
        refundId: row.id,
        reference: row.reference,
        from: row.status as RefundStatus,
      };
      summary.checked += 1;

      let providerRefundId = row.paystack_refund_id;
      if (!providerRefundId) {
        const found = await this.findProviderRefund(row);
        if ('reason' in found) {
          summary.unresolved += 1;
          summary.results.push({ ...base, outcome: 'unresolved', reason: found.reason });
          continue;
        }
        providerRefundId = found.id;
        await this.db
          .update(refunds)
          .set({ paystack_refund_id: providerRefundId })
          .where(eq(refunds.id, row.id));
      }

      let status: string;
      try {
        const res = await this.refundVerifier.verifyRefund(providerRefundId);
        status = (res.data?.status ?? '').toLowerCase();
      } catch (err) {
        summary.unresolved += 1;
        summary.results.push({
          ...base,
          outcome: 'unresolved',
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Same shape as the payout loop: the verify call is wrapped above, but
      // confirmRefund writes under a lock and can throw too. A refund we
      // cannot resolve is a customer still out of pocket — report it and keep
      // going, rather than ending the sweep for everyone behind it.
      try {
        if (status === 'processed' || status === 'success') {
          await this.refundService.confirmRefund(row.reference, 'succeeded');
          summary.settled += 1;
          summary.results.push({ ...base, outcome: 'settled' });
        } else if (status === 'failed') {
          await this.refundService.confirmRefund(row.reference, 'failed', {
            error: 'provider reported the refund failed',
          });
          summary.failed += 1;
          summary.results.push({ ...base, outcome: 'failed', reason: 'refund failed' });
        } else {
          summary.stillPending += 1;
          summary.results.push({ ...base, outcome: 'still_pending', reason: status || 'pending' });
        }
      } catch (err) {
        summary.unresolved += 1;
        summary.results.push({
          ...base,
          outcome: 'unresolved',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return summary;
  }

  /**
   * The refund at Paystack behind a row that never learnt its provider id —
   * a lost response, or a crash between submit and record.
   *
   * Without this such a row could neither be verified nor safely re-sent, and
   * waited for a person indefinitely. Paystack lists a charge's refunds by its
   * numeric transaction id (only); exactly one unclaimed refund of the same
   * amount is this one. Anything else stays unresolved, with a reason that
   * says what Paystack actually holds.
   */
  private async findProviderRefund(row: Refund): Promise<{ id: string } | { reason: string }> {
    const verifier = this.refundVerifier!;
    if (!verifier.verifyTransaction || !verifier.listRefundsForTransaction) {
      return { reason: 'no provider refund id — cannot verify or safely re-send' };
    }
    if (!row.provider_transaction_reference) {
      return { reason: 'no provider refund id and no charge reference to look it up by' };
    }
    try {
      const charge = await verifier.verifyTransaction(row.provider_transaction_reference);
      const transactionId = charge.data?.id;
      if (transactionId === undefined || transactionId === null || transactionId === '') {
        return { reason: 'Paystack returned no transaction id for the charge' };
      }
      const listed = await verifier.listRefundsForTransaction(String(transactionId));
      const candidates = (listed.data ?? []).map(toRef).filter((r) => r !== null);
      if (candidates.length === 0) {
        return {
          reason:
            'no refund at Paystack for this charge — it was never created; check, then re-send',
        };
      }
      const match = await this.refundService!.matchProviderRefund(row, candidates);
      if (!match) {
        return {
          reason: `${candidates.length} refund(s) at Paystack for this charge, none an unclaimed match for this amount`,
        };
      }
      return { id: match.id };
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
