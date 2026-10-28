import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import {
  CardAuthorizationService,
  type ProviderAuthorization,
} from '../payments/card-authorization.service';
import type { AuditActorType } from '../audit/audit-logger.service';
import { AttemptRepository, type PaymentAttempt } from '../payments/attempt-repository';
import type { ChargeFailureEscalator } from '../payments/charge-failure-escalator';
import { CustomerPlansService } from '../schedules/customer-plans.service';
import { ScheduleStateService } from '../schedules/schedule-state.service';
import {
  IllegalScheduleTransitionError,
  ScheduleTerminalStateError,
} from '../schedules/state-machine';
import { WebhookSignatureError } from './errors';
import { RefundOutcomeConflictError } from '../refunds/refund.service';

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

/** The slice of SettlementService this needs to apply a transfer outcome. */
export interface PayoutConfirmer {
  confirmPayout(
    reference: string,
    outcome: 'settled' | 'failed' | 'reversed',
    opts?: { transferId?: string; error?: string },
  ): Promise<unknown>;
}

/** The slice of RefundService this needs to apply a refund outcome. */
export interface RefundConfirmer {
  confirmRefund(
    reference: string,
    outcome: 'succeeded' | 'failed',
    opts?: { providerRefundId?: string; error?: string },
  ): Promise<unknown>;
  /**
   * Refund webhooks identify the *original transaction*, not the refund, and
   * carry no reference of ours — so the link back to our row is the charge
   * reference we recorded at intent time.
   */
  findByProviderTransactionReference(
    transactionReference: string,
  ): Promise<{ reference: string } | undefined>;
}

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference: string;
    status?: string;
    gateway_response?: string;
    /**
     * Present on a successful card charge. This is the only place a card paid
     * through a hosted Paystack page ever surfaces — the synchronous path never
     * sees it — so a webhook that ignores it throws the saved card away.
     */
    authorization?: ProviderAuthorization;
    [key: string]: unknown;
  };
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
 * The original charge reference a refund event refers to. Paystack nests it
 * differently depending on the endpoint that produced the payload, so check
 * both shapes rather than trusting one.
 */
function transactionReferenceOf(event: PaystackWebhookEvent): string | undefined {
  const flat = event.data?.transaction_reference;
  if (typeof flat === 'string' && flat) return flat;
  const nested = (event.data?.transaction as { reference?: unknown } | undefined)?.reference;
  return typeof nested === 'string' && nested ? nested : undefined;
}

/**
 * Ingests Paystack webhooks. Rejects bad signatures, dedupes replays via
 * `webhook_events` (a re-delivery is a no-op once processed), and dispatches
 * charge outcomes to the same settle/fail handlers the synchronous path uses —
 * idempotently, so a webhook that races the synchronous charge does no harm.
 */
/**
 * Settles a customer-initiated order payment from its provider reference.
 *
 * Orders deliberately do not use `payment_attempts` — that table is shaped for
 * installment schedules, and its readers include the credit-scoring behaviour
 * collector — so their reference lives on the order instead. This port is how
 * the webhook reaches across to commerce without core depending on it.
 *
 * Returns true when the reference belonged to an order (settled, or already
 * settled), so the caller knows not to alert on it.
 */
export interface OrderPaymentSettler {
  settleByPaymentReference(
    reference: string,
    actor: { actorId: string; actorType: AuditActorType },
  ): Promise<boolean>;
}

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
    /**
     * Applies outbound transfer outcomes. Without it a `transfer.reversed`
     * cannot be acted on and is only alerted.
     */
    private readonly settlements?: PayoutConfirmer,
    /**
     * Applies customer refund outcomes. Paystack settles GHS refunds
     * asynchronously, so without this a refund stays `pending_confirmation`
     * until the slower reconciliation sweep notices.
     */
    private readonly refunds?: RefundConfirmer,
    /**
     * Settles a customer-initiated order payment. Without it, a shopper paying
     * for an order by Mobile Money is charged and the order never advances —
     * the money arrives and the goods never ship.
     */
    private readonly orderPayments?: OrderPaymentSettler,
    /**
     * Keeps the reusable card authorization that arrives with a successful
     * charge. Without it, a customer who pays by card on a hosted page settles
     * their instalment and is asked for the card again next month.
     */
    private readonly cards?: CardAuthorizationService,
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
    // Refund events carry no `reference` — they identify the original
    // transaction instead. Without this fallback every refund webhook would
    // dedupe to `refund.processed:no-ref`, so the first one processed would
    // silently swallow every later refund of the same type.
    const providerEventId = `${eventType}:${event.data?.reference ?? transactionReferenceOf(event) ?? 'no-ref'}`;

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
    if (event.event.startsWith('transfer.')) {
      await this.handleTransfer(event);
      return;
    }
    if (event.event.startsWith('refund.')) {
      await this.handleRefund(event);
      return;
    }
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
      // Not an installment charge. It may be a customer paying for an order:
      // those carry their reference on the order row rather than in
      // payment_attempts, so try there before treating it as unknown.
      if (event.event === 'charge.success' && this.orderPayments) {
        const settled = await this.orderPayments
          .settleByPaymentReference(reference, WEBHOOK_ACTOR)
          .catch(() => false);
        if (settled) return;
      }
      // Paystack is telling us a customer was charged against a reference we
      // have no record of. Returning silently loses that fact permanently.
      this.alert({ eventType: event.event, reference, reason: 'no payment_attempt for reference' });
      return;
    }

    if (event.event === 'charge.success') {
      await this.handleSuccess(attempt, reference, event.data.authorization);
    } else {
      await this.handleFailure(attempt, reference, event.data.gateway_response ?? 'charge_failed');
    }
  }

  /**
   * Outbound merchant transfers.
   *
   * `dispatch` previously dropped every event that was not a charge, so
   * `transfer.success`, `transfer.failed` and `transfer.reversed` were ingested,
   * marked processed and discarded. Paystack routinely reverses GHS transfers
   * days later when the recipient bank or MoMo account rejects them — and when
   * that happened the payout stayed `settled` forever, `merchant_payable`
   * stayed cleared, and the merchant was recorded as paid while holding
   * nothing. Nothing else in the system would ever have noticed.
   */
  /**
   * Customer refunds. Paystack settles GHS refunds asynchronously, so the
   * submit call usually returns `pending` and the real outcome arrives here.
   *
   * Nothing about a refund event identifies our record directly — it names the
   * original transaction — so the link is the charge reference stored at intent
   * time. An event we cannot match is alerted rather than dropped: it means
   * money moved on an account we believe we own and cannot account for.
   */
  private async handleRefund(event: PaystackWebhookEvent): Promise<void> {
    const outcome =
      event.event === 'refund.processed'
        ? 'succeeded'
        : event.event === 'refund.failed'
          ? 'failed'
          : undefined;
    if (!outcome) return; // refund.pending / refund.processing — not terminal

    const transactionReference = transactionReferenceOf(event);
    if (!transactionReference) {
      this.alert({
        eventType: event.event,
        reference: '(none)',
        reason: 'refund event carried no transaction reference',
      });
      return;
    }
    if (!this.refunds) {
      this.alert({
        eventType: event.event,
        reference: transactionReference,
        reason: 'no refund service wired to apply the refund outcome',
      });
      return;
    }

    const refund = await this.refunds.findByProviderTransactionReference(transactionReference);
    if (!refund) {
      this.alert({
        eventType: event.event,
        reference: transactionReference,
        reason: 'no refund record for transaction reference',
      });
      return;
    }

    try {
      await this.refunds.confirmRefund(refund.reference, outcome, {
        error: outcome === 'failed' ? (event.data.gateway_response ?? event.event) : undefined,
      });
    } catch (err) {
      // A conflict is not a failure to process: retrying the event cannot
      // change what it says, so it is raised for a person and the event closed.
      if (err instanceof RefundOutcomeConflictError) {
        this.alert({ eventType: event.event, reference: refund.reference, reason: err.message });
        return;
      }
      this.alert({
        eventType: event.event,
        reference: refund.reference,
        reason: `could not apply refund outcome: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }

  private async handleTransfer(event: PaystackWebhookEvent): Promise<void> {
    const reference = event.data.reference;
    if (!reference) {
      this.alert({
        eventType: event.event,
        reference: '(none)',
        reason: 'transfer event carried no reference',
      });
      return;
    }
    if (!this.settlements) {
      this.alert({
        eventType: event.event,
        reference,
        reason: 'no settlement service wired to apply the transfer outcome',
      });
      return;
    }

    // `reversed` stays distinct from `failed`: a reversal usually arrives
    // after the payout settled, and only a reversal may undo a settlement.
    const outcome =
      event.event === 'transfer.success'
        ? 'settled'
        : event.event === 'transfer.reversed'
          ? 'reversed'
          : event.event === 'transfer.failed'
            ? 'failed'
            : undefined;
    if (!outcome) return; // transfer.* we do not act on

    try {
      await this.settlements.confirmPayout(reference, outcome, {
        transferId: typeof event.data.id === 'string' ? event.data.id : undefined,
        error: event.data.gateway_response ?? event.event,
      });
    } catch (err) {
      // An unknown reference means Paystack moved money we have no payout for.
      this.alert({
        eventType: event.event,
        reference,
        reason: `could not apply transfer outcome: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }

  /**
   * Saves a reusable card that arrived with a webhook-delivered success.
   *
   * Best effort on purpose: the money has moved and the schedule is about to be
   * settled. Failing to keep the card costs the customer one prompt next month;
   * throwing here would leave a real payment unrecorded.
   */
  private async rememberCard(
    attempt: PaymentAttempt,
    authorization?: ProviderAuthorization,
  ): Promise<void> {
    if (!this.cards || !authorization?.reusable) return;
    try {
      const plan = await this.plans.get(attempt.customer_plan_id);
      await this.cards.record(plan.customer_id, authorization);
      await this.cards.markUsed(authorization.authorization_code);
    } catch {
      /* best effort — see the doc above */
    }
  }

  private async handleSuccess(
    attempt: PaymentAttempt,
    reference: string,
    authorization?: ProviderAuthorization,
  ): Promise<void> {
    await this.rememberCard(attempt, authorization);
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
