import {
  CustomerPlansService,
  type InstallmentScheduleRow,
  type PlanActor,
} from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository, type PaymentAttempt, type PaymentMethod } from './attempt-repository';
import { classifyFailure } from './failure-classifier';
import { InstallmentNotChargeableError } from './errors';

interface PaystackChargeResponse {
  data: {
    reference: string;
    status: string;
    gateway_response?: string;
    display_text?: string;
  };
}

/** The slice of the Paystack client this service needs (card + MoMo charges). */
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
   * failed    — declined synchronously, schedule failed (or overdue if non-retryable);
   * pending   — async charge initiated (MoMo pay_offline), webhook or verify resolves it;
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
 *   - failed     → record the decline, classify, escalate if non-retryable
 *   - network    → mark the attempt `unknown` (never assume "didn't charge")
 */
export class PaymentService {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly schedules: ScheduleStateService,
    private readonly attempts: AttemptRepository,
    private readonly paystack: PaystackChargeClient,
  ) {}

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

    // Card responses are synchronous: success or decline, no pay_offline.
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
      // Rare for MoMo but possible: immediate success.
      return this.settleAttemptSuccess(attempt.id, installment.id, response, actor);
    }
    if (status === 'pay_offline' || status === 'pending') {
      // Customer prompted on their phone; the webhook (or a verify poll) lands the outcome.
      const updated = await this.attempts.update(attempt.id, {
        providerReference: response.data.reference,
        rawResponse: response,
      });
      return { status: 'pending', attempt: updated, providerReference: response.data.reference };
    }
    return this.handleSyncFailure(attempt.id, installment.id, response, actor);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Drives the installment to `processing` and creates the in-flight attempt
   * row + a stable provider reference. Returns the loaded installment so the
   * caller can use its amount + customer-plan id.
   */
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
    // Stable across retries → a Paystack 500 + replay won't double-charge.
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
    await this.schedules.applyEvent(scheduleId, 'charge_failed', { ...actor, reason });
    if (classifyFailure(reason) === 'non_retryable') {
      await this.schedules.applyEvent(scheduleId, 'non_retryable_decline', { ...actor, reason });
    }
    return { status: 'failed', attempt: failed, failureReason: reason };
  }

  private async markAttemptUnknown(attemptId: string, err: unknown): Promise<ChargeResult> {
    // HTTP 5xx / timeout / network — DON'T mark failed. Leave it for a verify poll.
    const updated = await this.attempts.update(attemptId, {
      status: 'unknown',
      failureReason: err instanceof Error ? err.message : 'network_error',
    });
    return { status: 'unknown', attempt: updated };
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
