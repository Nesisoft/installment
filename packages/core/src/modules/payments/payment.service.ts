import {
  CustomerPlansService,
  type InstallmentScheduleRow,
  type PlanActor,
} from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
} from '../schedules/state-machine';
import { CardAuthorizationService, type ProviderAuthorization } from './card-authorization.service';
import { AttemptRepository, type PaymentAttempt, type PaymentMethod } from './attempt-repository';
import {
  ChargeAlreadyInFlightError,
  InstallmentNotChargeableError,
  PaymentAttemptNotFoundError,
} from './errors';
import { MAX_VERIFY_POLLS } from './retry-policy';
import type { RetryScheduler } from './retry-scheduler';
import { ChargeFailureEscalator, type ChargeReceiptNotifier } from './charge-failure-escalator';
import { AlternativeInstruments } from './alternative-instruments';
import type { CustomersService } from '../customers/customers.service';
import {
  declineFromChargeError,
  invalidAuthorizationFrom,
  isNotFoundAtProvider,
} from './provider-decline';
import { LockAcquisitionError, type RedisLock } from '../../shared/lock/redis-lock';

/**
 * Held for the whole initiate-charge critical section. Long enough to cover a
 * slow provider call, short enough that a crashed process frees the schedule
 * well inside the retry cadence.
 */
const CHARGE_LOCK_TTL_MS = 45_000;

interface PaystackChargeResponse {
  data: {
    reference: string;
    status: string;
    gateway_response?: string;
    display_text?: string;
    /** Present on a successful card charge; only the reusable ones are kept. */
    authorization?: ProviderAuthorization;
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

export type { ChargeReceiptNotifier } from './charge-failure-escalator';

/** Records a MoMo charge outcome for telco health (satisfied by TelcoHealthMonitor). */
export interface TelcoChargeRecorder {
  recordOutcome(provider: 'mtn' | 'tgo' | 'vod', success: boolean): Promise<void> | void;
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
    /** Optional telco health recorder — best-effort; never affects the charge. */
    private readonly telcoRecorder?: TelcoChargeRecorder,
    /**
     * Serialises charge initiation per schedule across processes. Optional so
     * framework-free callers can omit it — the state-machine transition and the
     * unresolved-attempt check still prevent a double charge without it, but
     * production should always wire this: it closes the window between reading
     * the installment and transitioning it.
     */
    private readonly lock?: RedisLock,
    /**
     * Keeps a reusable card authorization from a successful charge, so the next
     * instalment can be collected without the customer approving anything.
     *
     * Last in the list on purpose: these parameters are positional, and adding
     * one in the middle silently rebinds every existing caller's arguments —
     * which is exactly what happened on the first attempt here, with a Redis
     * lock landing on this parameter.
     */
    private readonly cards?: CardAuthorizationService,
    /**
     * Lets the escalator see whether another instrument is on file, so an
     * instrument-level decline does not end the retry ladder while one is.
     * Last, for the reason the comment above gives.
     */
    customers?: Pick<CustomersService, 'get'>,
  ) {
    const alternatives =
      customers && cards
        ? new AlternativeInstruments(attempts, plans, customers, cards)
        : undefined;
    this.escalator = new ChargeFailureEscalator(
      plans,
      schedules,
      retryScheduler,
      receipts,
      alternatives,
    );
  }

  /**
   * The shared post-failure pipeline. WebhookService is given the same
   * instance, so a decline delivered by webhook escalates and retries exactly
   * as a synchronous one does.
   */
  private readonly escalator: ChargeFailureEscalator;

  /**
   * Runs the initiate-charge critical section under a per-schedule lock. A
   * caller that loses the race fails fast (waitMs 0) rather than queueing
   * behind a live charge — a queued duplicate would debit the customer again
   * the moment the first one finished.
   */
  private async withChargeLock<T>(scheduleId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.lock) return fn();
    try {
      return await this.lock.withLock(
        `charge:${scheduleId}`,
        { ttlMs: CHARGE_LOCK_TTL_MS, waitMs: 0 },
        fn,
      );
    } catch (err) {
      if (err instanceof LockAcquisitionError) {
        throw new ChargeAlreadyInFlightError(scheduleId, 'another charge holds the lock');
      }
      throw err;
    }
  }

  /** Fires a receipt SMS without ever letting it affect the charge outcome. */
  private notify(fn: (n: ChargeReceiptNotifier) => Promise<void>): void {
    if (!this.receipts) return;
    void fn(this.receipts).catch(() => {
      // Best-effort: receipts must never surface as a charge failure.
    });
  }

  /** Records a MoMo charge outcome for telco health — best-effort, never throws. */
  private recordTelco(provider: 'mtn' | 'tgo' | 'vod', success: boolean): void {
    if (!this.telcoRecorder) return;
    void Promise.resolve(this.telcoRecorder.recordOutcome(provider, success)).catch(() => {
      // Best-effort: telco metrics must never surface as a charge failure.
    });
  }

  async chargeCard(input: ChargeCardInput, actor: PlanActor): Promise<ChargeResult> {
    return this.withChargeLock(input.scheduleId, async () => {
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
        // The card itself is dead, not this one charge declined: retire it so
        // the next debit falls back to Mobile Money, and fail the attempt now —
        // Paystack created no transaction, so the verify poll has nothing to
        // find.
        const deadCard = invalidAuthorizationFrom(err);
        if (deadCard) {
          await this.retireCard(input.authorizationCode, deadCard.reason);
          return this.recordFailure(
            attempt.id,
            installment.id,
            deadCard.reason,
            deadCard.body,
            actor,
          );
        }
        // A decline arrives as a 400 the client throws — see provider-decline.
        const declined = declineFromChargeError(err);
        if (declined) {
          return this.recordFailure(
            attempt.id,
            installment.id,
            declined.reason,
            declined.body,
            actor,
          );
        }
        return this.markAttemptUnknown(attempt.id, err);
      }

      if (response.data.status === 'success') {
        return this.settleAttemptSuccess(
          attempt.id,
          installment.id,
          response,
          actor,
          installment.customer_plan_id,
        );
      }
      return this.handleSyncFailure(attempt.id, installment.id, response, actor);
    });
  }

  async chargeMobileMoney(input: ChargeMobileMoneyInput, actor: PlanActor): Promise<ChargeResult> {
    return this.withChargeLock(input.scheduleId, async () => {
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
        // A decline arrives as a 400 the client throws — see provider-decline.
        const declined = declineFromChargeError(err);
        if (declined) {
          this.recordTelco(input.provider, false);
          return this.recordFailure(
            attempt.id,
            installment.id,
            declined.reason,
            declined.body,
            actor,
          );
        }
        return this.markAttemptUnknown(attempt.id, err);
      }

      const status = response.data.status;
      if (status === 'success') {
        this.recordTelco(input.provider, true);
        return this.settleAttemptSuccess(
          attempt.id,
          installment.id,
          response,
          actor,
          installment.customer_plan_id,
        );
      }
      if (status === 'pay_offline' || status === 'pending') {
        // In-flight — not a telco-decisive outcome; the webhook/verify resolves it.
        const updated = await this.attempts.update(attempt.id, {
          providerReference: response.data.reference,
          rawResponse: response,
        });
        return { status: 'pending', attempt: updated, providerReference: response.data.reference };
      }
      this.recordTelco(input.provider, false);
      return this.handleSyncFailure(attempt.id, installment.id, response, actor);
    });
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
      // Paystack has no transaction under this reference, and the attempt is
      // old enough that a request still in flight is no longer possible: no
      // money moved. Every other throw stays `unknown`. Before this, a charge
      // Paystack refused without creating a transaction — a saved card it no
      // longer honours — sat `unknown` for good, and its instalment in
      // `processing`, out of reach of retries and collections alike.
      if (isNotFoundAtProvider(err) && olderThan(attempt.initiated_at, NOT_FOUND_SETTLE_MS)) {
        return this.recordVerifyFailure(attempt, 'not_found_at_paystack', null, actor);
      }
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
    // `abandoned` is how a declined card charge verifies (captured from test
    // mode): nothing was taken. It used to fall through to
    // `unknown_status:abandoned`, which failed the attempt but threw away
    // Paystack's reason.
    if (data.status === 'failed' || data.status === 'abandoned') {
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
        // Budget exhausted while the provider still says "pending". That is
        // NOT a failure — we genuinely do not know whether money moved, and
        // Paystack may yet resolve it. Recording it as `failed` would classify
        // as retryable and issue a fresh charge on top of a possibly-live one.
        // Park it in `unknown` for the reconciler and a human to resolve.
        const parked = await this.attempts.update(attempt.id, {
          status: 'unknown',
          failureReason: 'timeout_no_resolution',
          rawResponse: response,
          lastVerifiedAt: new Date(),
          verifyPollCount: nextCount,
        });
        return {
          status: 'unknown',
          attempt: parked,
          providerReference: attempt.provider_reference,
        };
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

    // An unresolved attempt means money may already be moving for this
    // installment (`in_flight`), or we genuinely don't know (`unknown`).
    // Charging again on top of either is how a customer gets debited twice.
    const unresolved = await this.attempts.findUnresolvedForSchedule(scheduleId);
    if (unresolved) {
      throw new ChargeAlreadyInFlightError(
        scheduleId,
        `attempt ${unresolved.id} is ${unresolved.status}`,
      );
    }

    await this.ensureProcessing(installment, actor);
    const attemptNumber = installment.attempt_count + 1;
    const idempotencyKey = `${scheduleId}:${attemptNumber}`;
    // Paystack's reference charset excludes ':' — keep the colon-joined key
    // internal and send a charset-safe reference. UNIQUE(idempotency_key) is
    // what actually de-duplicates; the reference just has to be stable.
    const reference = `INSTL-${scheduleId}-${attemptNumber}`;
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
    customerPlanId?: string,
  ): Promise<ChargeResult> {
    const providerReference = response.data.reference;
    const succeeded = await this.attempts.update(attemptId, {
      status: 'succeeded',
      providerReference,
      rawResponse: response,
      settledAt: new Date(),
    });
    await this.plans.recordChargeSuccess(scheduleId, { providerReference }, actor);
    await this.rememberCard(response.data.authorization, customerPlanId);
    this.notify((n) => n.notifyChargeSucceeded(scheduleId, succeeded.amount_pesewas));
    return { status: 'succeeded', attempt: succeeded, providerReference };
  }

  /**
   * Saves a reusable card off the back of a successful charge.
   *
   * Deliberately swallows its own failures. The money has already moved and the
   * schedule is already paid; losing a saved card costs the customer one Mobile
   * Money prompt next month, whereas throwing here would report a successful
   * payment as a failure.
   */
  private async rememberCard(
    authorization: ProviderAuthorization | undefined,
    customerPlanId: string | undefined,
  ): Promise<void> {
    if (!this.cards || !authorization?.reusable || !customerPlanId) return;
    try {
      const plan = await this.plans.get(customerPlanId);
      await this.cards.record(plan.customer_id, authorization);
      await this.cards.markUsed(authorization.authorization_code);
    } catch {
      /* best effort — see the doc above */
    }
  }

  private async handleSyncFailure(
    attemptId: string,
    scheduleId: string,
    response: PaystackChargeResponse,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const reason = response.data.gateway_response ?? 'charge_failed';
    return this.recordFailure(attemptId, scheduleId, reason, response, actor);
  }

  /**
   * Takes a saved card Paystack will no longer charge off the rotation.
   *
   * `CardAuthorizationService.revoke` existed for this and had no caller, so a
   * dead card stayed `active`, `findUsable` chose it for every debit, and the
   * runner never reached its Mobile Money fallback. Best-effort: if this write
   * fails the attempt is still recorded, and the next charge on the same card
   * gets the same answer and retires it then.
   */
  private async retireCard(authorizationCode: string, reason: string): Promise<void> {
    if (!this.cards) return;
    try {
      await this.cards.revoke(authorizationCode, `invalid_authorization_code: ${reason}`);
    } catch {
      // See above: never let bookkeeping on the card mask the charge outcome.
    }
  }

  /** A charge Paystack answered as declined: record it and escalate, now. */
  private async recordFailure(
    attemptId: string,
    scheduleId: string,
    reason: string,
    rawResponse: unknown,
    actor: PlanActor,
  ): Promise<ChargeResult> {
    const failed = await this.attempts.update(attemptId, {
      status: 'failed',
      failureReason: reason,
      rawResponse,
      failedAt: new Date(),
    });
    await this.escalator.apply(scheduleId, reason, actor);
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
    await this.escalator.apply(attempt.schedule_id, reason, actor);
    return { status: 'failed', attempt: failed, failureReason: reason };
  }

  /** Exposes the shared failure pipeline so WebhookService reuses it verbatim. */
  get failureEscalator(): ChargeFailureEscalator {
    return this.escalator;
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
        // Already being charged. Treating this as a no-op (as this once did)
        // let a second caller through: it read a stale attempt_count, derived a
        // different idempotency key and reference, and slipped past
        // UNIQUE(idempotency_key) to issue a second live charge.
        throw new ChargeAlreadyInFlightError(id, 'installment is already processing');
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

/**
 * How long a charge reference must have existed before Paystack's "not found"
 * is taken as proof that no transaction exists. A request that timed out on our
 * side may still be landing at Paystack; a quarter of an hour later it has
 * either arrived or never will. Matches the verify poll's own staleness window.
 */
const NOT_FOUND_SETTLE_MS = 15 * 60_000;

/** Whether `iso` is at least `ms` in the past. Unparseable reads as "not yet". */
function olderThan(iso: string, ms: number): boolean {
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && Date.now() - at >= ms;
}
