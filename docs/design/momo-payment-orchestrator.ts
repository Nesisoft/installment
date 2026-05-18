// ============================================================================
// momo-payment-orchestrator.ts
// ----------------------------------------------------------------------------
// Orchestrates Mobile Money charges via Paystack with retry & fallback.
//
// Key realities this code is built around:
//   1. Paystack MoMo charges are ASYNC — the HTTP response is "pay_offline",
//      the actual result arrives via webhook minutes later (or never).
//   2. The customer must approve on their phone (USSD or app prompt).
//      Many customers ignore the prompt — silent timeout is the norm.
//   3. Webhooks can be late, lost, or duplicated. NEVER trust them alone —
//      always poll /transaction/verify as a fallback for stuck attempts.
//   4. Idempotency is non-negotiable. A Paystack 500 doesn't mean "didn't
//      charge" — it means "we don't know." Retry with the same reference.
// ============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// 1. RETRY POLICY — data, not branching logic
// ---------------------------------------------------------------------------

interface RetryStep {
  attempt: number;
  delayHours: number;
  channel: 'auto_debit' | 'payment_link';
  reminderMinutesBefore: number;
}

const RETRY_POLICY: RetryStep[] = [
  { attempt: 1, delayHours: 0,  channel: 'auto_debit',   reminderMinutesBefore: 60 },
  { attempt: 2, delayHours: 4,  channel: 'auto_debit',   reminderMinutesBefore: 30 },
  { attempt: 3, delayHours: 24, channel: 'auto_debit',   reminderMinutesBefore: 60 },
  { attempt: 4, delayHours: 48, channel: 'payment_link', reminderMinutesBefore: 0  },
];

const MAX_ATTEMPTS = RETRY_POLICY.length;

// ---------------------------------------------------------------------------
// 2. FAILURE CLASSIFICATION — maps Paystack reasons to retry intent
// ---------------------------------------------------------------------------

type FailureClass = 'retryable' | 'non_retryable' | 'ambiguous';

const PAYSTACK_DECLINE_MAP: Record<string, FailureClass> = {
  // Transient — retry later
  insufficient_funds:    'retryable',
  declined_by_customer:  'retryable',
  pin_timeout:           'retryable',
  expired:               'retryable',
  generic_error:         'retryable',
  network_timeout:       'retryable',

  // Permanent — never retry, escalate to operations
  invalid_account:       'non_retryable',
  fraud_block:           'non_retryable',
  account_closed:        'non_retryable',
  customer_blocked:      'non_retryable',
  blocked_card:          'non_retryable',
  unsupported_network:   'non_retryable',
};

function classifyFailure(decline: string | undefined): FailureClass {
  if (!decline) return 'ambiguous';
  return PAYSTACK_DECLINE_MAP[decline.toLowerCase()] ?? 'ambiguous';
}

// ---------------------------------------------------------------------------
// 3. THE ORCHESTRATOR
// ---------------------------------------------------------------------------

@Injectable()
export class MomoPaymentOrchestrator {
  private readonly logger = new Logger(MomoPaymentOrchestrator.name);

  constructor(
    private readonly paystack: PaystackClient,
    private readonly state: ScheduleStateService,
    private readonly notifications: NotificationService,
    private readonly attempts: AttemptRepository,
    private readonly debitQueue: Queue,
    private readonly verifyQueue: Queue,
  ) {}

  // -------------------------------------------------------------------------
  // ENTRY POINT — called by the Debit Worker
  // -------------------------------------------------------------------------
  async charge(scheduleId: string): Promise<void> {
    const schedule = await this.loadScheduleOrThrow(scheduleId);

    if (schedule.attemptCount >= MAX_ATTEMPTS) {
      this.logger.warn(`Schedule ${scheduleId} exhausted retries`);
      await this.escalateToCollections(scheduleId, 'retries_exhausted');
      return;
    }

    const step = RETRY_POLICY[schedule.attemptCount];
    const attemptId = randomUUID();
    // Idempotency key persists across retries of the SAME charge,
    // so a Paystack 500 followed by replay doesn't double-debit.
    const idempotencyKey = `${scheduleId}:${schedule.attemptCount + 1}`;

    // 1. Transition state → "processing" (acquires the state lock)
    await this.state.applyEvent('debit_initiated', {
      scheduleId,
      actorId: 'momo_orchestrator',
      actorType: 'worker',
      occurredAt: new Date(),
      metadata: { attemptId, step: step.attempt },
    });

    // 2. Pre-record attempt BEFORE calling Paystack
    //    (so we know about it even if Paystack call crashes our process)
    await this.attempts.create({
      id: attemptId,
      scheduleId,
      provider: 'paystack',
      channel: step.channel,
      amount: schedule.amountDue,
      status: 'in_flight',
      idempotencyKey,
      initiatedAt: new Date(),
    });

    // 3. Choose channel — auto-debit OR send payment link
    if (step.channel === 'auto_debit') {
      await this.attemptAutoDebit(schedule, attemptId, idempotencyKey);
    } else {
      await this.sendPaymentLink(schedule, attemptId);
    }
  }

  // -------------------------------------------------------------------------
  // AUTO-DEBIT PATH — Paystack MoMo charge
  // -------------------------------------------------------------------------
  private async attemptAutoDebit(
    schedule: Schedule,
    attemptId: string,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      const response = await this.paystack.chargeMobileMoney({
        email: schedule.customer.email,
        amount: schedule.amountDue,   // already in pesewas (integer)
        currency: 'GHS',
        phone: schedule.customer.momoPhone,
        provider: schedule.customer.momoProvider, // 'mtn' | 'tgo' | 'vod'
        idempotencyKey,
        reference: `INSTL-${schedule.id}-${idempotencyKey}`,
        metadata: {
          schedule_id: schedule.id,
          attempt_id: attemptId,
          customer_id: schedule.customerId,
        },
      });

      // Persist Paystack reference for webhook correlation
      await this.attempts.update(attemptId, {
        providerReference: response.data.reference,
        rawResponse: response,
      });

      switch (response.data.status) {
        case 'pay_offline':
          // Most common MoMo path — push sent to customer's phone.
          // Schedule a verification poll as safety net in case webhook is lost.
          await this.scheduleVerificationPoll(attemptId, 15 * 60 * 1000); // 15 min
          break;

        case 'success':
          // Rare for MoMo, but treat as immediate success.
          await this.handleSuccess(attemptId, response.data.reference);
          break;

        case 'failed':
          await this.handleFailure(
            attemptId,
            response.data.gateway_response ?? 'unknown',
          );
          break;

        default:
          this.logger.error(`Unknown Paystack status: ${response.data.status}`);
          await this.scheduleVerificationPoll(attemptId, 15 * 60 * 1000);
      }
    } catch (err: any) {
      // HTTP 5xx, timeout, network error — DON'T mark as failed.
      // Schedule verification poll; the charge may have actually succeeded.
      this.logger.error(`Paystack call errored for ${attemptId}`, err);
      await this.attempts.update(attemptId, {
        status: 'unknown',
        lastError: err.message,
      });
      await this.scheduleVerificationPoll(attemptId, 5 * 60 * 1000); // 5 min
    }
  }

  // -------------------------------------------------------------------------
  // PAYMENT LINK PATH — fallback when auto-debit keeps failing
  // -------------------------------------------------------------------------
  private async sendPaymentLink(
    schedule: Schedule,
    attemptId: string,
  ): Promise<void> {
    const link = await this.paystack.createPaymentLink({
      amount: schedule.amountDue,
      currency: 'GHS',
      email: schedule.customer.email,
      reference: `INSTL-${schedule.id}-LINK-${attemptId}`,
      callback_url: `${process.env.APP_URL}/payments/return`,
      metadata: { schedule_id: schedule.id, attempt_id: attemptId },
    });

    await this.attempts.update(attemptId, {
      providerReference: link.data.reference,
      paymentLinkUrl: link.data.url,
    });

    await this.notifications.sendSms({
      phone: schedule.customer.phone,
      template: 'payment_link_final',
      variables: {
        amount: formatCedis(schedule.amountDue),
        url: link.data.url,
        due_date: schedule.dueDate,
      },
    });

    // Give customer 24h to use link; verify on expiry
    await this.scheduleVerificationPoll(attemptId, 24 * 60 * 60 * 1000);
  }

  // -------------------------------------------------------------------------
  // WEBHOOK HANDLER — called from PaystackWebhookController
  // -------------------------------------------------------------------------
  async handleWebhook(event: PaystackWebhookEvent): Promise<void> {
    // Idempotency: have we seen this exact event before?
    const seen = await this.attempts.hasProcessedEvent(event.id);
    if (seen) {
      this.logger.log(`Duplicate webhook ${event.id} ignored`);
      return;
    }

    const attempt = await this.attempts.findByProviderReference(
      event.data.reference,
    );
    if (!attempt) {
      this.logger.warn(`Webhook for unknown reference ${event.data.reference}`);
      return;
    }

    if (event.event === 'charge.success') {
      await this.handleSuccess(attempt.id, event.data.reference);
    } else if (event.event === 'charge.failed') {
      await this.handleFailure(
        attempt.id,
        event.data.gateway_response ?? 'unknown',
      );
    }

    await this.attempts.markEventProcessed(event.id);
  }

  // -------------------------------------------------------------------------
  // VERIFICATION POLL — safety net when webhook is late or lost
  // -------------------------------------------------------------------------
  async verifyAttempt(attemptId: string): Promise<void> {
    const attempt = await this.attempts.findOrThrow(attemptId);

    // Already resolved? Nothing to do.
    if (attempt.status !== 'in_flight' && attempt.status !== 'unknown') {
      return;
    }

    if (!attempt.providerReference) {
      // Network died before Paystack returned a reference. Assume failed.
      await this.handleFailure(attemptId, 'no_reference_issued');
      return;
    }

    const verified = await this.paystack.verifyTransaction(
      attempt.providerReference,
    );

    switch (verified.data.status) {
      case 'success':
        await this.handleSuccess(attemptId, attempt.providerReference);
        break;
      case 'failed':
        await this.handleFailure(
          attemptId,
          verified.data.gateway_response ?? 'verify_returned_failed',
        );
        break;
      case 'pending':
      case 'ongoing':
        // Still pending after our poll window. Try once more, then give up.
        if (attempt.verifyPollCount < 2) {
          await this.scheduleVerificationPoll(attemptId, 30 * 60 * 1000);
        } else {
          await this.handleFailure(attemptId, 'timeout_no_resolution');
        }
        break;
      default:
        this.logger.error(`Unknown verify status: ${verified.data.status}`);
        await this.handleFailure(attemptId, 'unknown_status');
    }
  }

  // -------------------------------------------------------------------------
  // OUTCOME HANDLERS
  // -------------------------------------------------------------------------
  private async handleSuccess(
    attemptId: string,
    providerReference: string,
  ): Promise<void> {
    const attempt = await this.attempts.findOrThrow(attemptId);

    await this.attempts.update(attemptId, {
      status: 'succeeded',
      settledAt: new Date(),
    });

    await this.state.applyEvent('charge_succeeded', {
      scheduleId: attempt.scheduleId,
      actorId: 'paystack',
      actorType: 'webhook',
      providerReference,
      occurredAt: new Date(),
    });

    await this.notifications.sendSms({
      phone: attempt.customerPhone,
      template: 'payment_received',
      variables: { amount: formatCedis(attempt.amount) },
    });
  }

  private async handleFailure(
    attemptId: string,
    reason: string,
  ): Promise<void> {
    const attempt = await this.attempts.findOrThrow(attemptId);

    await this.attempts.update(attemptId, {
      status: 'failed',
      failureReason: reason,
      failedAt: new Date(),
    });

    await this.state.applyEvent('charge_failed', {
      scheduleId: attempt.scheduleId,
      actorId: 'paystack',
      actorType: 'webhook',
      reason,
      occurredAt: new Date(),
    });

    // Classify and route
    const cls = classifyFailure(reason);

    if (cls === 'non_retryable') {
      await this.escalateToCollections(attempt.scheduleId, reason);
      return;
    }

    // Retryable or ambiguous — schedule next attempt if we have one
    const schedule = await this.loadScheduleOrThrow(attempt.scheduleId);
    if (schedule.attemptCount >= MAX_ATTEMPTS) {
      // Out of retries — wait for grace period to expire, then collections
      await this.notifications.sendSms({
        phone: schedule.customer.phone,
        template: 'retries_exhausted',
        variables: { amount: formatCedis(schedule.amountDue) },
      });
      return;
    }

    await this.state.applyEvent('retryable', {
      scheduleId: attempt.scheduleId,
      actorId: 'momo_orchestrator',
      actorType: 'system',
      reason,
      occurredAt: new Date(),
    });

    const nextStep = RETRY_POLICY[schedule.attemptCount];
    const delayMs = nextStep.delayHours * 60 * 60 * 1000;

    // Enqueue next debit attempt with delay
    await this.debitQueue.add(
      'debit',
      { scheduleId: attempt.scheduleId },
      { delay: delayMs, jobId: `debit:${attempt.scheduleId}:${nextStep.attempt}` },
    );

    // Notify customer of the retry
    await this.notifications.sendSms({
      phone: schedule.customer.phone,
      template: 'debit_will_retry',
      variables: {
        amount: formatCedis(schedule.amountDue),
        next_attempt: humanizeDelay(delayMs),
        reason: friendlyReason(reason),
      },
    });
  }

  // -------------------------------------------------------------------------
  // HELPERS
  // -------------------------------------------------------------------------
  private async escalateToCollections(
    scheduleId: string,
    reason: string,
  ): Promise<void> {
    await this.state.applyEvent('non_retryable_decline', {
      scheduleId,
      actorId: 'momo_orchestrator',
      actorType: 'system',
      reason,
      occurredAt: new Date(),
    });

    this.logger.warn(`Schedule ${scheduleId} escalated to collections: ${reason}`);
  }

  private async scheduleVerificationPoll(
    attemptId: string,
    delayMs: number,
  ): Promise<void> {
    await this.verifyQueue.add(
      'verify',
      { attemptId },
      { delay: delayMs, jobId: `verify:${attemptId}` },
    );
  }

  private async loadScheduleOrThrow(scheduleId: string): Promise<Schedule> {
    // omitted: DB load with customer join
    return {} as Schedule;
  }
}

// ---------------------------------------------------------------------------
// 4. PAYSTACK WEBHOOK CONTROLLER — verifies signature, dispatches event
// ---------------------------------------------------------------------------

/*
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  constructor(
    private readonly orchestrator: MomoPaymentOrchestrator,
    private readonly paystack: PaystackClient,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Headers('x-paystack-signature') signature: string,
    @RawBody() raw: Buffer,
  ): Promise<{ ok: true }> {
    // 1. Signature verification — reject early
    if (!this.paystack.verifySignature(raw, signature)) {
      throw new ForbiddenException('Invalid signature');
    }

    const event: PaystackWebhookEvent = JSON.parse(raw.toString());

    // 2. Only process events we care about
    if (event.event === 'charge.success' || event.event === 'charge.failed') {
      // Process asynchronously to keep webhook response under 5s
      await this.orchestrator.handleWebhook(event);
    }

    // 3. Always 200 to Paystack — they retry on non-2xx
    return { ok: true };
  }
}
*/

// ---------------------------------------------------------------------------
// 5. TYPE STUBS (referenced above)
// ---------------------------------------------------------------------------

interface Schedule {
  id: string;
  customerId: string;
  amountDue: number;        // pesewas
  dueDate: Date;
  attemptCount: number;
  customer: {
    email: string;
    phone: string;
    momoPhone: string;
    momoProvider: 'mtn' | 'tgo' | 'vod';
  };
}

interface PaystackWebhookEvent {
  id: string;
  event: string;
  data: {
    reference: string;
    status: string;
    gateway_response?: string;
    paid_at?: string;
  };
}

declare class PaystackClient {
  chargeMobileMoney(req: any): Promise<any>;
  createPaymentLink(req: any): Promise<any>;
  verifyTransaction(reference: string): Promise<any>;
  verifySignature(raw: Buffer, signature: string): boolean;
}

declare class ScheduleStateService {
  applyEvent(event: string, ctx: any): Promise<any>;
}

declare class NotificationService {
  sendSms(req: any): Promise<void>;
}

declare class AttemptRepository {
  create(a: any): Promise<void>;
  update(id: string, patch: any): Promise<void>;
  findByProviderReference(ref: string): Promise<any>;
  findOrThrow(id: string): Promise<any>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
}

declare function formatCedis(pesewas: number): string;
declare function humanizeDelay(ms: number): string;
declare function friendlyReason(code: string): string;
