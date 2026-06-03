import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { AttemptRepository, type PaymentAttempt } from '../payments/attempt-repository';
import { classifyFailure } from '../payments/failure-classifier';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
} from '../schedules/state-machine';
import { WebhookSignatureError } from './errors';

const we = schema.webhook_events;

export interface PaystackWebhookEvent {
  event: string;
  data: { reference: string; status?: string; gateway_response?: string; [key: string]: unknown };
}

/** Just enough of the Paystack client to verify a raw webhook body. */
export interface WebhookSignatureVerifier {
  verifySignature(rawBody: string | Buffer, signature: string): boolean;
}

export interface WebhookIngestResult {
  /** false = duplicate (replay) or an event type we don't act on. */
  processed: boolean;
  eventType: string;
}

const WEBHOOK_ACTOR = { actorId: SYSTEM_ACTORS.WEBHOOK, actorType: 'webhook' as const };

/**
 * Ingests Paystack webhooks. Rejects bad signatures, dedupes replays via
 * `webhook_events` (a re-delivery is a no-op once processed), and dispatches
 * charge outcomes to the same settle/fail handlers the synchronous path uses —
 * idempotently, so a webhook that races the synchronous charge does no harm.
 */
export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly verifier: WebhookSignatureVerifier,
    private readonly attempts: AttemptRepository,
    private readonly plans: CustomerPlansService,
    private readonly schedules: ScheduleStateService,
  ) {}

  /** `rawBody` MUST be the exact bytes Paystack signed (no re-stringify). */
  async ingest(rawBody: string, signature: string): Promise<WebhookIngestResult> {
    if (!this.verifier.verifySignature(rawBody, signature)) {
      throw new WebhookSignatureError();
    }
    const event = JSON.parse(rawBody) as PaystackWebhookEvent;
    const eventType = event.event;
    const providerEventId = `${eventType}:${event.data?.reference ?? 'no-ref'}`;

    await this.db
      .insert(we)
      .values({
        provider: 'paystack',
        provider_event_id: providerEventId,
        event_type: eventType,
        payload: event,
        signature,
      })
      .onConflictDoNothing();

    const stored = (
      await this.db
        .select()
        .from(we)
        .where(and(eq(we.provider, 'paystack'), eq(we.provider_event_id, providerEventId)))
        .limit(1)
    )[0];
    if (stored?.processed_at) return { processed: false, eventType };

    try {
      await this.dispatch(event);
    } catch (err) {
      await this.db
        .update(we)
        .set({ processing_error: err instanceof Error ? err.message : String(err) })
        .where(and(eq(we.provider, 'paystack'), eq(we.provider_event_id, providerEventId)));
      throw err;
    }

    await this.db
      .update(we)
      .set({ processed_at: new Date().toISOString(), processing_error: null })
      .where(and(eq(we.provider, 'paystack'), eq(we.provider_event_id, providerEventId)));
    return { processed: true, eventType };
  }

  private async dispatch(event: PaystackWebhookEvent): Promise<void> {
    if (event.event !== 'charge.success' && event.event !== 'charge.failed') return;
    const reference = event.data.reference;
    if (!reference) return;
    const attempt = await this.attempts.findByProviderReference(reference);
    if (!attempt) return; // a reference we don't track — nothing to do

    if (event.event === 'charge.success') {
      await this.handleSuccess(attempt, reference);
    } else {
      await this.handleFailure(attempt, event.data.gateway_response ?? 'charge_failed');
    }
  }

  private async handleSuccess(attempt: PaymentAttempt, reference: string): Promise<void> {
    if (attempt.status !== 'succeeded') {
      await this.attempts.update(attempt.id, {
        status: 'succeeded',
        providerReference: reference,
        settledAt: new Date(),
      });
    }
    await this.idempotent(() =>
      this.plans.recordChargeSuccess(
        attempt.schedule_id,
        { providerReference: reference },
        WEBHOOK_ACTOR,
      ),
    );
  }

  private async handleFailure(attempt: PaymentAttempt, reason: string): Promise<void> {
    if (attempt.status !== 'failed') {
      await this.attempts.update(attempt.id, {
        status: 'failed',
        failureReason: reason,
        failedAt: new Date(),
      });
    }
    await this.idempotent(async () => {
      await this.schedules.applyEvent(attempt.schedule_id, 'charge_failed', {
        ...WEBHOOK_ACTOR,
        reason,
      });
      if (classifyFailure(reason) === 'non_retryable') {
        await this.schedules.applyEvent(attempt.schedule_id, 'non_retryable_decline', {
          ...WEBHOOK_ACTOR,
          reason,
        });
      }
    });
  }

  /**
   * Swallows "already in the target state" transitions: when the synchronous
   * charge path already settled (or failed) the schedule, the confirming
   * webhook's transition is illegal — and that's exactly the no-op we want.
   */
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
}
