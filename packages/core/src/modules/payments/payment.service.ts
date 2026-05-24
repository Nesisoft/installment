import {
  CustomerPlansService,
  type InstallmentScheduleRow,
  type PlanActor,
} from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import { AttemptRepository, type PaymentAttempt } from './attempt-repository';
import { classifyFailure } from './failure-classifier';
import { InstallmentNotChargeableError } from './errors';

/** The slice of the Paystack client the card charge path needs. */
export interface PaystackChargeClient {
  chargeCard(req: {
    email: string;
    amount: number;
    currency: 'GHS';
    authorization_code: string;
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ data: { reference: string; status: string; gateway_response?: string } }>;
}

export interface ChargeCardInput {
  scheduleId: string;
  /** Paystack authorization code from a prior tokenised card (Inline). */
  authorizationCode: string;
  /** Customer email Paystack charges against. */
  email: string;
}

export interface ChargeResult {
  status: 'succeeded' | 'failed' | 'unknown';
  attempt: PaymentAttempt;
  providerReference?: string;
  failureReason?: string;
}

/**
 * Card charge orchestration (synchronous happy path; the webhook later
 * confirms). Drives the installment to `processing`, logs an attempt before
 * calling Paystack, then settles on success, records the failure (classifying
 * it) on decline, or leaves the attempt `unknown` on a network error so a
 * verify poll can resolve it — never assuming a charge didn't happen.
 */
export class PaymentService {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly schedules: ScheduleStateService,
    private readonly attempts: AttemptRepository,
    private readonly paystack: PaystackChargeClient,
  ) {}

  async chargeCard(input: ChargeCardInput, actor: PlanActor): Promise<ChargeResult> {
    const installment = await this.plans.getInstallment(input.scheduleId);
    await this.ensureProcessing(installment, actor);

    // Stable across retries of the same charge → a Paystack 500 + replay won't double-charge.
    const idempotencyKey = `${input.scheduleId}:${installment.attempt_count + 1}`;
    const reference = `INSTL-${input.scheduleId}-${idempotencyKey}`;
    const amount = installment.amount_due_pesewas + installment.late_fee_pesewas;

    const attempt = await this.attempts.create({
      scheduleId: input.scheduleId,
      customerPlanId: installment.customer_plan_id,
      channel: 'auto_debit',
      paymentMethod: 'card',
      amountPesewas: amount,
      idempotencyKey,
      providerReference: reference,
    });

    let response: Awaited<ReturnType<PaystackChargeClient['chargeCard']>>;
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
      // HTTP 5xx / timeout / network — DON'T mark failed. Leave it for a verify poll.
      const updated = await this.attempts.update(attempt.id, {
        status: 'unknown',
        failureReason: err instanceof Error ? err.message : 'network_error',
      });
      return { status: 'unknown', attempt: updated };
    }

    if (response.data.status === 'success') {
      const succeeded = await this.attempts.update(attempt.id, {
        status: 'succeeded',
        providerReference: response.data.reference,
        rawResponse: response,
        settledAt: new Date(),
      });
      await this.plans.recordChargeSuccess(
        input.scheduleId,
        { providerReference: response.data.reference },
        actor,
      );
      return {
        status: 'succeeded',
        attempt: succeeded,
        providerReference: response.data.reference,
      };
    }

    // Any non-success synchronous status is a decline for the card path.
    const reason = response.data.gateway_response ?? 'charge_failed';
    const failed = await this.attempts.update(attempt.id, {
      status: 'failed',
      failureReason: reason,
      rawResponse: response,
      failedAt: new Date(),
    });
    await this.schedules.applyEvent(input.scheduleId, 'charge_failed', { ...actor, reason });
    if (classifyFailure(reason) === 'non_retryable') {
      await this.schedules.applyEvent(input.scheduleId, 'non_retryable_decline', {
        ...actor,
        reason,
      });
    }
    return { status: 'failed', attempt: failed, failureReason: reason };
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
