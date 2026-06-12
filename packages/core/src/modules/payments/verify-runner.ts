import type { PlanActor } from '../schedules/customer-plans.service';
import type { AttemptRepository } from './attempt-repository';
import type { PaymentService, ChargeResult } from './payment.service';

/** One verify-poll outcome (mirrors a ChargeResult status, plus `skipped`). */
export interface VerifyOutcome {
  attemptId: string;
  scheduleId: string;
  status: ChargeResult['status'] | 'skipped';
  reason?: string;
}

export interface VerifySweepSummary {
  checked: number;
  succeeded: number;
  failed: number;
  pending: number;
  unknown: number;
  skipped: number;
  outcomes: VerifyOutcome[];
}

/**
 * Drains the lost-webhook backlog. A MoMo charge that returns `pay_offline`
 * leaves the attempt `in_flight` until a webhook (or this poll) resolves it —
 * so without this sweep a dropped webhook would strand the installment in
 * `processing` forever.
 *
 * Each stale attempt is re-verified against Paystack via
 * {@link PaymentService.verifyAttempt} (which is idempotent and caps polls at
 * MAX_VERIFY_POLLS before timing the attempt out to `failed`).
 */
export class VerifyRunner {
  constructor(
    private readonly attempts: AttemptRepository,
    private readonly payments: PaymentService,
  ) {}

  /** Re-verifies every in-flight attempt stale as of `staleBefore`. Never throws per attempt. */
  async sweepStale(
    staleBefore: Date,
    actor: PlanActor,
    opts: { limit?: number } = {},
  ): Promise<VerifySweepSummary> {
    const stale = await this.attempts.findStaleInFlight(staleBefore, opts.limit);
    const summary: VerifySweepSummary = {
      checked: 0,
      succeeded: 0,
      failed: 0,
      pending: 0,
      unknown: 0,
      skipped: 0,
      outcomes: [],
    };

    for (const attempt of stale) {
      summary.checked += 1;
      let outcome: VerifyOutcome;
      try {
        const result = await this.payments.verifyAttempt(attempt.id, actor);
        outcome = {
          attemptId: attempt.id,
          scheduleId: attempt.schedule_id,
          status: result.status,
          reason: result.failureReason,
        };
      } catch (err) {
        outcome = {
          attemptId: attempt.id,
          scheduleId: attempt.schedule_id,
          status: 'skipped',
          reason: err instanceof Error ? err.message : 'verify_failed',
        };
      }
      summary.outcomes.push(outcome);
      switch (outcome.status) {
        case 'succeeded':
          summary.succeeded += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        case 'unknown':
          summary.unknown += 1;
          break;
        default:
          summary.skipped += 1;
      }
    }

    return summary;
  }
}
