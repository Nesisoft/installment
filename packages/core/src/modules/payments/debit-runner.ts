import type { CustomerPlansService, PlanActor } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { PaymentService, ChargeResult } from './payment.service';
import type { CardAuthorizationService } from './card-authorization.service';
import type { AttemptRepository } from './attempt-repository';

/** Outcome of one auto-debit attempt. `skipped` means we couldn't even try. */
export interface DebitAttemptOutcome {
  scheduleId: string;
  status: ChargeResult['status'] | 'skipped';
  /** Why it was skipped (e.g. no MoMo instrument on file). */
  reason?: string;
  providerReference?: string;
}

export interface DebitSweepSummary {
  asOfDate: string;
  attempted: number;
  succeeded: number;
  pending: number;
  failed: number;
  unknown: number;
  skipped: number;
  outcomes: DebitAttemptOutcome[];
}

function isMomoProvider(provider: string): provider is 'mtn' | 'tgo' | 'vod' {
  return provider === 'mtn' || provider === 'tgo' || provider === 'vod';
}

/**
 * Drives auto-debit for installments that are due.
 *
 * Prefers a saved card authorization, and falls back to the customer's Mobile
 * Money. That order is the whole point: a card authorization debits without the
 * customer doing anything, while a MoMo charge sends a prompt they have to
 * notice and approve — so a collection run that reaches for MoMo first turns
 * every instalment into a request rather than a collection.
 *
 * It picks ONE instrument per run and does not cascade. Trying the card and
 * then MoMo in the same pass is how a charge that actually succeeded but
 * reported a failure becomes two debits; the retry ladder is what tries again,
 * with PaymentService's unresolved-attempt guard in between.
 *
 * Shared by the hourly debit sweep (first attempts on pending/due rows) and the
 * retry worker (auto_debit retries on retry_scheduled rows) — PaymentService's
 * state machine guards keep concurrent attempts from double-charging.
 */
export class DebitRunner {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly payments: PaymentService,
    /**
     * Optional so framework-free callers keep working; without it collection
     * falls back to Mobile Money exactly as before.
     */
    private readonly cards?: CardAuthorizationService,
    /** Optional too; without it a card is tried on every attempt, as before. */
    private readonly attempts?: Pick<AttemptRepository, 'findLatestForSchedule'>,
  ) {}

  /**
   * Attempts a single auto-debit on the best instrument on file. Never throws.
   */
  async attemptAutoDebit(scheduleId: string, actor: PlanActor): Promise<DebitAttemptOutcome> {
    let phone: string;
    let provider: string;
    let email: string;
    let customerId: string;
    try {
      const installment = await this.plans.getInstallment(scheduleId);
      const plan = await this.plans.get(installment.customer_plan_id);
      const customer = await this.customers.get(plan.customer_id);
      customerId = customer.id;
      phone = customer.momo_phone ?? '';
      provider = customer.momo_provider ?? '';
      email = customer.email;
    } catch (err) {
      return {
        scheduleId,
        status: 'skipped',
        reason: err instanceof Error ? err.message : 'lookup_failed',
      };
    }

    const momoOnFile = Boolean(phone) && isMomoProvider(provider);
    // A saved card collects silently, so it is tried first when there is one.
    const card = this.cards ? await this.cards.findUsable(customerId).catch(() => null) : null;
    /**
     * Unless that card is what just failed. Every retry went back to the same
     * card, so a customer whose card was empty and whose wallet was funded ran
     * the whole retry ladder on the card — to the payment link, then the late
     * fee — and the Mobile Money number on file was never tried. After a
     * declined card attempt the next attempt, still one instrument per run,
     * goes to Mobile Money; a failure there brings the card back. Mobile Money
     * needs the customer's approval on their handset, so this cannot take money
     * they did not mean to pay.
     */
    const last = this.attempts
      ? await this.attempts.findLatestForSchedule(scheduleId).catch(() => undefined)
      : undefined;
    const cardJustDeclined = last?.payment_method === 'card' && last.status === 'failed';
    if (card && !(cardJustDeclined && momoOnFile)) {
      try {
        const result = await this.payments.chargeCard(
          { scheduleId, email, authorizationCode: card.authorization_code },
          actor,
        );
        return {
          scheduleId,
          status: result.status,
          providerReference: result.providerReference,
          reason: result.failureReason,
        };
      } catch (err) {
        return {
          scheduleId,
          status: 'skipped',
          reason: err instanceof Error ? err.message : 'card_charge_failed',
        };
      }
    }

    if (!momoOnFile || !isMomoProvider(provider)) {
      return { scheduleId, status: 'skipped', reason: 'no_instrument' };
    }

    try {
      const result = await this.payments.chargeMobileMoney(
        { scheduleId, email, phone, provider },
        actor,
      );
      return {
        scheduleId,
        status: result.status,
        providerReference: result.providerReference,
        reason: result.failureReason,
      };
    } catch (err) {
      // A charge that throws out of PaymentService (e.g. illegal transition
      // because another worker grabbed the row) is a skip, not a crash.
      return {
        scheduleId,
        status: 'skipped',
        reason: err instanceof Error ? err.message : 'charge_failed',
      };
    }
  }

  /** Sweeps every installment due for a first auto-debit attempt as of `asOf`. */
  async sweepDue(
    asOf: Date,
    actor: PlanActor,
    opts: { limit?: number } = {},
  ): Promise<DebitSweepSummary> {
    const due = await this.plans.listDueForAutoDebit(asOf, opts.limit);
    const summary: DebitSweepSummary = {
      asOfDate: asOf.toISOString().slice(0, 10),
      attempted: 0,
      succeeded: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      outcomes: [],
    };

    for (const installment of due) {
      const outcome = await this.attemptAutoDebit(installment.id, actor);
      summary.attempted += 1;
      summary.outcomes.push(outcome);
      switch (outcome.status) {
        case 'succeeded':
          summary.succeeded += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'unknown':
          summary.unknown += 1;
          break;
        default:
          summary.skipped += 1;
      }
    }

    return summary;
  }
}
