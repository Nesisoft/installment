import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { AttemptRepository, type PaymentAttempt } from '../payments/attempt-repository';
import type { ChargeFailureEscalator } from '../payments/charge-failure-escalator';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
} from '../schedules/state-machine';
import { WebhookSignatureError } from './errors';

const we = schema.webhook_events;
const sched = schema.installment_schedule;

/**
 * Where a webhook we could not apply goes. A charge outcome we cannot act on
 * means the provider believes money moved and our books disagree — that must
 * never be a silent return. Best-effort: an alerting failure must not roll back
 * a webhook we did process.
 */
export interface WebhookAlertSink {
  unhandled(detail: {
    eventType: string;
    reference: string;
    reason: string;
    scheduleId?: string;
  }): Promise<void> | void;
}

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
    /**
     * The same pipeline PaymentService runs after a synchronous decline. Wire
     * it (production always should) and a webhook-delivered failure escalates,
     * schedules its retry and sends its SMS identically. Without it the
     * schedule still transitions to `failed`, but the retry ladder never runs.
     */
    private readonly escalator?: ChargeFailureEscalator,
    /** Optional sink for outcomes we could not apply — best-effort. */
    private readonly alerts?: WebhookAlertSink,
  ) {}

  /** Reports an unapplied outcome without ever failing the ingest. */
  private alert(detail: {
    eventType: string;
    reference: string;
    reason: string;
    scheduleId?: string;
  }): void {
    if (!this.alerts) return;
    void Promise.resolve(this.alerts.unhandled(detail)).catch(() => {
      // Best-effort: alerting must never surface as a webhook failure.
    });
  }

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
    if (!reference) {
      this.alert({
        eventType: event.event,
        reference: '(none)',
        reason: 'event carried no reference',
      });
      return;
    }
    const attempt = await this.attempts.findByProviderReference(reference);
    if (!attempt) {
      // Paystack is telling us a customer was charged against a reference we
      // have no record of. Returning silently loses that fact permanently.
      this.alert({ eventType: event.event, reference, reason: 'no payment_attempt for reference' });
      return;
    }

    if (event.event === 'charge.success') {
      await this.handleSuccess(attempt, reference);
    } else {
      await this.handleFailure(attempt, reference, event.data.gateway_response ?? 'charge_failed');
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
    try {
      await this.plans.recordChargeSuccess(
        attempt.schedule_id,
        { providerReference: reference },
        WEBHOOK_ACTOR,
      );
    } catch (err) {
      if (!this.isTransitionError(err)) throw err;
      // The schedule refused the settlement. Only one shape of that is benign:
      // it is already paid under this same reference (a re-delivery, or the
      // synchronous path won the race). Anything else means money moved and we
      // did not record it — surface it rather than swallowing it.
      if (await this.alreadySettledUnder(attempt.schedule_id, reference)) return;
      this.alert({
        eventType: 'charge.success',
        reference,
        scheduleId: attempt.schedule_id,
        reason: `could not settle schedule: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }

  private async handleFailure(
    attempt: PaymentAttempt,
    reference: string,
    reason: string,
  ): Promise<void> {
    // A late failure for a superseded attempt must not clobber a newer one.
    // findByProviderReference returns whatever attempt owns this reference,
    // which may already be resolved or may have been replaced by a retry.
    if (attempt.status === 'succeeded') {
      this.alert({
        eventType: 'charge.failed',
        reference,
        scheduleId: attempt.schedule_id,
        reason: 'failure for an attempt already recorded as succeeded — ignored',
      });
      return;
    }
    if (attempt.status !== 'failed') {
      await this.attempts.update(attempt.id, {
        status: 'failed',
        failureReason: reason,
        failedAt: new Date(),
      });
    }

    // Parity with the synchronous path: escalate, schedule the retry, notify.
    // Before this, a webhook failure stopped at `charge_failed`, so on MoMo —
    // where the outcome always arrives by webhook — the entire retry ladder and
    // payment-link fallback never ran.
    if (this.escalator) {
      await this.escalator.apply(attempt.schedule_id, reason, WEBHOOK_ACTOR);
      return;
    }
    await this.idempotent(() =>
      this.schedules.applyEvent(attempt.schedule_id, 'charge_failed', {
        ...WEBHOOK_ACTOR,
        reason,
      }),
    );
  }

  /** True when the schedule is already `paid` under exactly this reference. */
  private async alreadySettledUnder(scheduleId: string, reference: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ status: sched.status, providerReference: sched.provider_reference })
        .from(sched)
        .where(eq(sched.id, scheduleId))
        .limit(1)
    )[0];
    return row?.status === 'paid' && row.providerReference === reference;
  }

  private isTransitionError(err: unknown): boolean {
    return (
      err instanceof IllegalScheduleTransitionError || err instanceof ScheduleTerminalStateError
    );
  }

  /** Swallows illegal/terminal transition errors thrown from within `fn`. */
  private async idempotent(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (this.isTransitionError(err)) return;
      throw err;
    }
  }
}
