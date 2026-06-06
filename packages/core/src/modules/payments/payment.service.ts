import {
  CustomerPlansService,
  type InstallmentScheduleRow,
  type PlanActor,
} from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
  type ScheduleEvent,
} from '../schedules/state-machine';
import { AttemptRepository, type PaymentAttempt, type PaymentMethod } from './attempt-repository';
import { classifyFailure } from './failure-classifier';
import { InstallmentNotChargeableError, PaymentAttemptNotFoundError } from './errors';
import { MAX_VERIFY_POLLS, retryStepFor } from './retry-policy';
import type { RetryScheduler } from './retry-scheduler';

const HOUR_MS = 3_600_000;

interface PaystackChargeResponse {
  data: {
    reference: string;
    status: string;
    gateway_response?: string;
    display_text?: string;
  };
}

interface PaystackVerifyResponse {
  data: {
    reference: string;
    status: string;
    gateway_response?: string;
  };
}

/** The slice of the Paystack client this service needs (card + MoMo + verify). */
export interface PaystackChargeClient {
  chargeCard(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    authorization_code: string;
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaystackChargeResponse>;
  chargeMobileMoney(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    phone: string;
    provider: 'mtn' | 'tgo' | 'vod';
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaystackChargeResponse>;
  verifyTransaction(reference: string): Promise<PaystackVerifyResponse>;
}

/**
 * Customer-facing receipt SMS port. Fired after a terminal charge outcome
 * lands. Implementations must be best-effort (never throw, never block the
 * charge); PaymentService still wraps calls in try/catch as belt-and-braces.
 */
export interface ChargeReceiptNotifier {
  notifyChargeSucceeded(scheduleId: string, amountPesewas: number): Promise<void>;
  notifyChargeFailed(scheduleId: string, amountPesewas: number): Promise<void>;
}

export interface ChargeCardInput {
  scheduleId: string;
  /** Paystack authorization code from a prior tokenised card (Inline). */
  authorizationCode: string;
  /** Customer email Paystack charges against. */
  email: string;
}

export interface ChargeMobileMoneyInput {
  scheduleId: string;
  /** Customer email Paystack charges against. */
  email: string;
  /** Customer's MoMo phone (e.g. +233...). */
  phone: string;
  provider: 'mtn' | 'tgo' | 'vod';
}

export interface ChargeResult {
  /**
   * succeeded — money received, schedule paid;
   * failed    — declined; schedule retry_scheduled (retry enqueued), overdue
   *             (non-retryable), or failed (retries exhausted / no scheduler);
   * pending   — async charge initiated (MoMo pay_offline) or verify still pending;
   * unknown   — network / 5xx error, leave it for a verify poll.
   */
  status: 'succeeded' | 'failed' | 'pending' | 'unknown';
  attempt: PaymentAttempt;
  providerReference?: string;
  failureReason?: string;
}

/**
 * Charge orchestration. Drives the installment to `processing`, logs an
 * attempt before calling Paystack, then on the synchronous response:
 *   - success    → settle (schedule → paid, plan outstanding reduced)
 *   - pay_offline → leave the attempt in-flight; the webhook (or a verify
 *                   poll) resolves it (MoMo's normal path)
 *   - failed     → record the decline, then escalate (non-retryable → overdue)
 *                  or schedule the next retry (retryable → retry_scheduled)
 *   - network    → mark the attempt `unknown` (never assume "didn't charge")
 *
 * Retry scheduling is opt-in: when a {@link RetryScheduler} is injected, a
 * retryable failure with attempts remaining transitions the schedule to
 * `retry_scheduled` and enqueues the next attempt at the policy delay.
 * verifyAttempt is the safety net for lost webhooks.
 */
export class PaymentService {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly schedules: ScheduleStateService,
    private readonly attempts: AttemptRepository,
    private readonly paystack: PaystackChargeClient,
    private readonly retryScheduler?: RetryScheduler,
    /** Optional receipt SMS — best-effort; a failure never affects the charge. */
    private readonly receipts?: ChargeReceiptNotifier,
  ) {}

  /** Fires a receipt SMS without ever letting it affect the charge outcome. */
  private notify(fn: (n: ChargeReceiptNotifier) => Promise<void>): void {
    if (!this.receipts) return;
    void fn(this.receipts).catch(() => {
      // Best-effort: receipts must never surface as a charge failure.
    });
  }

  async chargeCard(input: ChargeCardInput, actor: PlanActor): Promise<ChargeResult> {
    const { attempt, reference, amount, installment } = await this.beginAttempt(
      input.scheduleId,
      'card',
      actor,
    );

    let response: PaystackChargeResponse;
    try {
      response = await this.paystack.chargeCard({
        email: input.email,
        amount,
        currency: 'GHS',
        authorization_code: input.authorizationCode,
        reference,
        metadata: { schedule_id: input.scheduleId, attempt_id: attempt.id },
      });
    } catch (err) {
      return this.markAttemptUnknown(attempt.id, err);
    }

    if (response.data.status === 'success') {
      return this.settleAttemptSuccess(attempt.id, installment.id, response, actor);
    }
    return this.handleSyncFailure(attempt.id, installment.id, response, actor);
  }

  async chargeMobileMoney(input: ChargeMobileMoneyInput, actor: PlanActor): Promise<ChargeResult> {
    const { attempt, reference, amount, installment } = await this.beginAttempt(
      input.scheduleId,
      'momo',
      actor,
    );

    let response: PaystackChargeResponse;
    try {
      response = await this.paystack.chargeMobileMoney({
        email: input.email,
        amount,
        currency: 'GHS',
        phone: input.phone,
        provider: input.provider,
        reference,
        metadata: { schedule_id: input.scheduleId, attempt_id: attempt.id },
      });
    } catch (err) {
      return this.markAttemptUnknown(attempt.id, err);
    }

    const status = response.data.status;
    if (status === 'success') {
      return this.settleAttemptSuccess(attempt.id, installment.id, response, actor);
    }
    if (status === 'pay_offline' || status === 'pending') {
      const updated = await this.attempts.update(attempt.id, {
        providerReference: response.data.reference,
        rawResponse: response,
      });
      return { status: 'pending', attempt: updated, providerReference: response.data.reference };
    }
    return this.handleSyncFailure(attempt.id, installment.id, response, actor);
  }

  /**
   * Polls Paystack directly for a stuck attempt and applies the outcome.
   * Already-resolved attempts return immediately. State transitions are
   * idempotent: a settle/fail call that races a webhook is a no-op.
   */
  async verifyAttempt(attemptId: string, actor: PlanActor): Promise<ChargeResult> {
    const attempt = await this.attempts.findById(attemptId);
    if (!attempt) throw new PaymentAttemptNotFoundError(attemptId);

    if (attempt.status === 'succeeded') {
      return {
        status: 'succeeded',
        attempt,
        providerReference: attempt.provider_reference ?? undefined,
      };
    }
    if (attempt.status === 'failed') {
      return { status: 'failed', attempt, failureReason: attempt.failure_reason ?? undefined };
    }

    if (!attempt.provider_reference) {
      return this.recordVerifyFailure(attempt, 'no_reference_issued', null, actor);
    }

    let response: PaystackVerifyResponse;
    try {
      response = await this.paystack.verifyTransaction(attempt.provider_reference);
    } catch (err) {
      const updated = await this.attempts.update(attempt.id, {
        status: 'unknown',
        lastVerifiedAt: new Date(),
        verifyPollCount: attempt.verify_poll_count + 1,
        failureReason: err instanceof Error ? err.message : 'verify_error',
      });
      return { status: 'unknown', attempt: updated };
    }

    const data = response.data;
    if (data.status === 'success') {
      return this.recordVerifySuccess(attempt, data.reference, response, actor);
    }
    if (data.status === 'failed') {
      return this.recordVerifyFailure(
        attempt,
        data.gateway_response ?? 'verify_returned_failed',
        response,
        actor,
      );
    }
    if (data.status === 'pending' || data.status === 'ongoing') {
      const nextCount = attempt.verify_poll_count + 1;
      if (nextCount >= MAX_VERIFY_POLLS) {
        return this.recordVerifyFailure(attempt, 'timeout_no_resolution', response, actor);
      }
      const updated = await this.attempts.update(attempt.id, {
        lastVerifiedAt: new Date(),
        verifyPollCount: nextCount,
      });
      return {
        status: 'pending',
        attempt: updated,
        providerReference: attempt.provider_reference,
      };
    }
    return this.recordVerifyFailure(attempt, `unknown_status:${data.status}`, response, actor);
  }

  // ---------------------------------------------------------------- internals

  private async beginAttempt(
    scheduleId: string,
    paymentMethod: PaymentMethod,
    actor: PlanActor,
  ): Promise<{
    installment: InstallmentScheduleRow;
    attempt: PaymentAttempt;
    reference: string;
    amount: number;
  }> {
    const installment = await this.plans.getInstallment(scheduleId);
    await this.ensureProcessing(installment, actor);
    const idempotencyKey = `${scheduleId}:${installment.attempt_count + 1}`;
    const reference = `INSTL-${scheduleId}-${idempotencyKey}`;
    const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;
    const attempt = await this.attempts.create({
      scheduleId,
      customerPlanId: installment.customer_plan_id,
      channel: 'auto_debit',
      paymentMethod,
      amountPesewas: amount,
      idempotencyKey,
      providerReference: reference,
    });
    return { installment, attempt, reference, amount };
  }

  private async settleAttemptSuccess(
    attemptId: string,
    scheduleId: string,
    response: PaystackChargeResponse,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const providerReference = response.data.reference;
    const succeeded = await this.attempts.update(attemptId, {
      status: 'succeeded',
      providerReference,
      rawResponse: response,
      settledAt: new Date(),
    });
    await this.plans.recordChargeSuccess(scheduleId, { providerReference }, actor);
    this.notify((n) => n.notifyChargeSucceeded(scheduleId, succeeded.amount_pesewas));
    return { status: 'succeeded', attempt: succeeded, providerReference };
  }

  private async handleSyncFailure(
    attemptId: string,
    scheduleId: string,
    response: PaystackChargeResponse,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const reason = response.data.gateway_response ?? 'charge_failed';
    const failed = await this.attempts.update(attemptId, {
      status: 'failed',
      failureReason: reason,
      rawResponse: response,
      failedAt: new Date(),
    });
    await this.tryEvent(scheduleId, 'charge_failed', { ...actor, reason });
    await this.afterFailure(scheduleId, reason, actor);
    return { status: 'failed', attempt: failed, failureReason: reason };
  }

  private async markAttemptUnknown(attemptId: string, err: unknown): Promise<ChargeResult> {
    const updated = await this.attempts.update(attemptId, {
      status: 'unknown',
      failureReason: err instanceof Error ? err.message : 'network_error',
    });
    return { status: 'unknown', attempt: updated };
  }

  private async recordVerifySuccess(
    attempt: PaymentAttempt,
    providerReference: string,
    rawResponse: unknown,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const succeeded = await this.attempts.update(attempt.id, {
      status: 'succeeded',
      providerReference,
      rawResponse,
      settledAt: new Date(),
      lastVerifiedAt: new Date(),
      verifyPollCount: attempt.verify_poll_count + 1,
    });
    await this.idempotent(() =>
      this.plans.recordChargeSuccess(attempt.schedule_id, { providerReference }, actor),
    );
    this.notify((n) => n.notifyChargeSucceeded(attempt.schedule_id, succeeded.amount_pesewas));
    return { status: 'succeeded', attempt: succeeded, providerReference };
  }

  private async recordVerifyFailure(
    attempt: PaymentAttempt,
    reason: string,
    rawResponse: unknown,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const failed = await this.attempts.update(attempt.id, {
      status: 'failed',
      failureReason: reason,
      rawResponse: rawResponse ?? undefined,
      failedAt: new Date(),
      lastVerifiedAt: new Date(),
      verifyPollCount: attempt.verify_poll_count + 1,
    });
    await this.tryEvent(attempt.schedule_id, 'charge_failed', { ...actor, reason });
    await this.afterFailure(attempt.schedule_id, reason, actor);
    return { status: 'failed', attempt: failed, failureReason: reason };
  }

  /**
   * After a failure lands the schedule in `failed`: a non-retryable reason
   * escalates to `overdue`; a retryable one (with attempts remaining and a
   * scheduler wired) transitions to `retry_scheduled` and enqueues the next
   * attempt — otherwise the row is left at `failed`.
   */
  private async afterFailure(scheduleId: string, reason: string, actor: PlanActor): Promise<void> {
    const installment = await this.plans.getInstallment(scheduleId);
    const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;

    if (classifyFailure(reason) === 'non_retryable') {
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

  /** Swallows illegal/terminal transition errors thrown from within `fn`. */
  private async idempotent(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (
        err instanceof IllegalScheduleTransitionError ||
        err instanceof ScheduleTerminalStateError
      ) {
        return;
      }
      throw err;
    }
  }

  /** Drives a chargeable installment to `processing` via the state machine. */
  private async ensureProcessing(
    installment: InstallmentScheduleRow,
    actor: PlanActor,
  ): Promise<void> {
    const id = installment.id;
    switch (installment.status) {
      case 'processing':
        return;
      case 'pending':
        await this.schedules.applyEvent(id, 'due_date_reached', actor);
        await this.schedules.applyEvent(id, 'debit_initiated', actor);
        return;
      case 'due':
        await this.schedules.applyEvent(id, 'debit_initiated', actor);
        return;
      case 'retry_scheduled':
        await this.schedules.applyEvent(id, 'backoff_elapsed', actor);
        await this.schedules.applyEvent(id, 'debit_initiated', actor);
        return;
      default:
        throw new InstallmentNotChargeableError(id, installment.status);
    }
  }
}
