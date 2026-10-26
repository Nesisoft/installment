import { CustomerPlansService, type PlanActor } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
  type ScheduleEvent,
} from '../schedules/state-machine';
import { classifyFailure } from './failure-classifier';
import { isInstrumentFailure } from './alternative-instruments';
import { retryStepFor } from './retry-policy';
import type { RetryScheduler } from './retry-scheduler';

const HOUR_MS = 3_600_000;

/**
 * Customer-facing receipt SMS port. Fired after a terminal charge outcome
 * lands. Implementations must be best-effort (never throw, never block the
 * charge); callers still wrap in try/catch as belt-and-braces.
 */
export interface ChargeReceiptNotifier {
  notifyChargeSucceeded(scheduleId: string, amountPesewas: number): Promise<void>;
  notifyChargeFailed(scheduleId: string, amountPesewas: number): Promise<void>;
}

/**
 * The single implementation of "a charge failed — now what?".
 *
 * This used to live only inside PaymentService, so it ran for synchronous
 * declines and for verify-poll failures but NOT for webhook-delivered ones.
 * On Ghanaian MoMo the synchronous response is `pay_offline` and the real
 * outcome arrives by webhook — so the retry ladder, the payment-link fallback
 * and the failure SMS were dead on the channel that matters most. Both callers
 * now share this class, which is the only way that parity stays true.
 */
export class ChargeFailureEscalator {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly schedules: ScheduleStateService,
    private readonly retryScheduler?: RetryScheduler,
    private readonly receipts?: ChargeReceiptNotifier,
    /**
     * Whether another instrument is on file for the auto-debit to try. Optional:
     * without it every non-retryable decline is final, as before.
     */
    private readonly alternatives?: { hasAnotherInstrument(scheduleId: string): Promise<boolean> },
  ) {}

  /**
   * Moves the schedule to `failed` and then escalates: a non-retryable reason
   * goes to `overdue`; a retryable one with attempts remaining (and a scheduler
   * wired) goes to `retry_scheduled` with the next attempt enqueued; otherwise
   * the row is left at `failed` for the grace-expiry sweep.
   */
  async apply(scheduleId: string, reason: string, actor: PlanActor): Promise<void> {
    await this.tryEvent(scheduleId, 'charge_failed', { ...actor, reason });
    await this.afterFailure(scheduleId, reason, actor);
  }

  private async afterFailure(scheduleId: string, reason: string, actor: PlanActor): Promise<void> {
    const installment = await this.plans.getInstallment(scheduleId);
    const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;

    // A decline that rules out the INSTRUMENT (a closed wallet, a blocked card)
    // is only final when there is nothing else to try. With another instrument
    // on file it takes the retryable path, and DebitRunner's next rung goes to
    // that instrument. A decline about the customer is final either way.
    if (
      classifyFailure(reason) === 'non_retryable' &&
      !(isInstrumentFailure(reason) && (await this.anotherInstrument(scheduleId)))
    ) {
      await this.tryEvent(scheduleId, 'non_retryable_decline', { ...actor, reason });
      this.notify((n) => n.notifyChargeFailed(scheduleId, amount)); // terminal
      return;
    }
    // No scheduler wired → the row stays `failed`, which is terminal here.
    if (!this.retryScheduler) {
      this.notify((n) => n.notifyChargeFailed(scheduleId, amount));
      return;
    }

    const nextAttempt = installment.attempt_count + 1;
    const step = retryStepFor(nextAttempt);
    if (!step) {
      // Out of retries — terminal failure; the grace-expiry worker escalates.
      this.notify((n) => n.notifyChargeFailed(scheduleId, amount));
      return;
    }

    // Retryable with attempts left: no SMS now — the retry / payment-link
    // messaging covers it, so the customer isn't pinged on every attempt.
    const moved = await this.tryEvent(scheduleId, 'retryable', { ...actor, reason });
    if (moved) {
      await this.retryScheduler.scheduleRetry({
        scheduleId,
        attempt: nextAttempt,
        channel: step.channel,
        delayMs: step.delayHours * HOUR_MS,
      });
    }
  }

  /** Best-effort: a lookup that fails leaves the decline final, as it always was. */
  private async anotherInstrument(scheduleId: string): Promise<boolean> {
    if (!this.alternatives) return false;
    return this.alternatives.hasAnotherInstrument(scheduleId).catch(() => false);
  }

  /** Fires a receipt SMS without ever letting it affect the charge outcome. */
  private notify(fn: (n: ChargeReceiptNotifier) => Promise<void>): void {
    if (!this.receipts) return;
    void fn(this.receipts).catch(() => {
      // Best-effort: receipts must never surface as a charge failure.
    });
  }

  /**
   * Applies a schedule event, returning whether it actually transitioned.
   * "Already in the target state" (illegal / terminal) returns false rather
   * than throwing — a transition that races a webhook is a safe no-op.
   */
  private async tryEvent(
    scheduleId: string,
    event: ScheduleEvent,
    ctx: { actorId: string; actorType: PlanActor['actorType']; reason?: string },
  ): Promise<boolean> {
    try {
      await this.schedules.applyEvent(scheduleId, event, ctx);
      return true;
    } catch (err) {
      if (
        err instanceof IllegalScheduleTransitionError ||
        err instanceof ScheduleTerminalStateError
      ) {
        return false;
      }
      throw err;
    }
  }
}
