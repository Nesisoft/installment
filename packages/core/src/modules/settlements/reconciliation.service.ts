import { asc, inArray } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { SettlementService, type PayoutStatus } from './settlement.service';

const payouts = schema.payouts;

/** Statuses that are not yet terminal and need a verify sweep. */
const RECONCILABLE_STATUSES = ['pending_confirmation', 'unknown'] as const;

/** The slice of the Paystack client the reconciler needs. */
export interface TransferVerifyClient {
  verifyTransfer(reference: string): Promise<{ data: { status: string; transfer_code?: string } }>;
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
      const result = await this.reconcileOne({
        id: payout.id,
        reference: payout.reference,
        status: payout.status as PayoutStatus,
      });
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
        await this.settlement.confirmPayout(payout.reference, 'failed', {
          error: 'transfer not found at Paystack',
        });
        return { ...base, outcome: 'failed', reason: 'not found at Paystack' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, outcome: 'unresolved', reason: message };
    }

    if (status === 'success') {
      await this.settlement.confirmPayout(payout.reference, 'settled');
      return { ...base, outcome: 'settled' };
    }
    if (status === 'failed' || status === 'reversed') {
      await this.settlement.confirmPayout(payout.reference, 'failed', {
        error: `transfer ${status}`,
      });
      return { ...base, outcome: 'failed', reason: `transfer ${status}` };
    }
    // pending / otp / ongoing → not terminal yet.
    return { ...base, outcome: 'still_pending', reason: status || 'pending' };
  }
}
