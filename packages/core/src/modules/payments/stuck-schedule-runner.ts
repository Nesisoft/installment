import { and, asc, eq, lt } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { PlanActor } from '../schedules/customer-plans.service';
import type { AttemptRepository } from './attempt-repository';
import type { PaymentService } from './payment.service';

const sched = schema.installment_schedule;

export interface StuckOutcome {
  scheduleId: string;
  /**
   * resolved   — a verify poll settled or failed the attempt;
   * pending    — still genuinely in flight at the provider;
   * unresolved — we could not determine the outcome (needs a human);
   * orphaned   — `processing` with no attempt at all (a crash mid-initiate).
   */
  outcome: 'resolved' | 'pending' | 'unresolved' | 'orphaned';
  attemptId?: string;
  reason?: string;
}

export interface StuckSweepSummary {
  checked: number;
  resolved: number;
  pending: number;
  unresolved: number;
  orphaned: number;
  outcomes: StuckOutcome[];
}

/** Alerted when a stuck schedule cannot be resolved automatically. */
export interface StuckScheduleAlertSink {
  stuck(detail: {
    scheduleId: string;
    outcome: StuckOutcome['outcome'];
    stuckSinceIso: string;
    reason?: string;
  }): Promise<void> | void;
}

/**
 * The reconciliation worker the schema always anticipated.
 * `schedule_stuck_idx` is a partial index on
 * `(status, status_changed_at) WHERE status = 'processing'`, carrying the
 * comment "Reconciliation worker — find stuck processing schedules". No such
 * worker existed.
 *
 * Without it, an installment that enters `processing` and never receives an
 * outcome stays there forever: `listDueForAutoDebit` selects only
 * pending/due, the retry queue never sees it, and the grace-expiry sweep
 * ignores it. The customer may or may not have been debited, and nobody ever
 * finds out. This sweep re-verifies the newest attempt and escalates anything
 * it cannot settle to a human.
 */
export class StuckScheduleRunner {
  constructor(
    private readonly db: Database,
    private readonly attempts: AttemptRepository,
    private readonly payments: PaymentService,
    private readonly alerts?: StuckScheduleAlertSink,
  ) {}

  /**
   * Re-verifies every schedule sitting in `processing` since before
   * `stuckBefore`. Never throws per schedule — one bad row must not stop the
   * sweep.
   */
  async sweep(
    stuckBefore: Date,
    actor: PlanActor,
    opts: { limit?: number } = {},
  ): Promise<StuckSweepSummary> {
    const rows = await this.db
      .select({ id: sched.id, since: sched.status_changed_at })
      .from(sched)
      .where(
        and(eq(sched.status, 'processing'), lt(sched.status_changed_at, stuckBefore.toISOString())),
      )
      .orderBy(asc(sched.status_changed_at))
      .limit(opts.limit ?? 200);

    const summary: StuckSweepSummary = {
      checked: 0,
      resolved: 0,
      pending: 0,
      unresolved: 0,
      orphaned: 0,
      outcomes: [],
    };

    for (const row of rows) {
      summary.checked += 1;
      const outcome = await this.resolveOne(row.id, actor);
      summary.outcomes.push(outcome);
      summary[outcome.outcome] += 1;

      if (outcome.outcome === 'unresolved' || outcome.outcome === 'orphaned') {
        this.alert({
          scheduleId: row.id,
          outcome: outcome.outcome,
          stuckSinceIso: row.since,
          reason: outcome.reason,
        });
      }
    }
    return summary;
  }

  private async resolveOne(scheduleId: string, actor: PlanActor): Promise<StuckOutcome> {
    const attempt = await this.attempts.findUnresolvedForSchedule(scheduleId);
    if (!attempt) {
      // `processing` with nothing in flight — the process died between the
      // state transition and the attempt insert, or the attempt already
      // resolved without the schedule following. Needs a human either way.
      return { scheduleId, outcome: 'orphaned', reason: 'no unresolved attempt for schedule' };
    }

    try {
      const result = await this.payments.verifyAttempt(attempt.id, actor);
      if (result.status === 'succeeded' || result.status === 'failed') {
        return { scheduleId, attemptId: attempt.id, outcome: 'resolved', reason: result.status };
      }
      if (result.status === 'pending') {
        return { scheduleId, attemptId: attempt.id, outcome: 'pending' };
      }
      return {
        scheduleId,
        attemptId: attempt.id,
        outcome: 'unresolved',
        reason: result.failureReason ?? 'verify returned unknown',
      };
    } catch (err) {
      return {
        scheduleId,
        attemptId: attempt.id,
        outcome: 'unresolved',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private alert(detail: Parameters<StuckScheduleAlertSink['stuck']>[0]): void {
    if (!this.alerts) return;
    void Promise.resolve(this.alerts.stuck(detail)).catch(() => {
      // Best-effort: alerting must never break the sweep.
    });
  }
}
