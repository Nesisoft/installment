import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { AttemptRepository } from './attempt-repository';
import type { CardAuthorizationService } from './card-authorization.service';
import { normaliseReason } from './failure-classifier';

export function isMomoProvider(provider: string): provider is 'mtn' | 'tgo' | 'vod' {
  return provider === 'mtn' || provider === 'tgo' || provider === 'vod';
}

/**
 * Non-retryable reasons that are about the instrument, not the customer: this
 * card is blocked, this wallet is closed or on a network Paystack cannot reach.
 * Retrying the same instrument is pointless, but a different one may well work.
 *
 * `fraud_block` and `customer_blocked` are deliberately absent. Those stop the
 * collection outright, whatever else is on file.
 */
const INSTRUMENT_FAILURES: ReadonlySet<string> = new Set([
  'invalid_account',
  'account_closed',
  'blocked_card',
  'unsupported_network',
]);

export function isInstrumentFailure(reason: string | null | undefined): boolean {
  return Boolean(reason) && INSTRUMENT_FAILURES.has(normaliseReason(reason!));
}

/**
 * Whether the auto-debit has somewhere else to go after its last instrument
 * failed for good.
 *
 * DebitRunner alternates instruments down the retry ladder: after a declined
 * card it tries Mobile Money, after a failed Mobile Money charge the card. But a
 * non-retryable decline sent the row straight to `overdue`, which nothing
 * charges — so a stale wallet tried as the fallback ended the ladder with a
 * usable card on file, and a blocked card ended it with a funded wallet on file.
 * The escalator asks this before giving up on an instrument-level decline.
 */
export class AlternativeInstruments {
  constructor(
    private readonly attempts: Pick<AttemptRepository, 'findLatestForSchedule'>,
    private readonly plans: Pick<CustomerPlansService, 'getInstallment' | 'get'>,
    private readonly customers: Pick<CustomersService, 'get'>,
    private readonly cards: Pick<CardAuthorizationService, 'findUsable'>,
  ) {}

  async hasAnotherInstrument(scheduleId: string): Promise<boolean> {
    // The attempt that just failed: the latest one that charged a saved
    // instrument. A payment-link attempt is the customer's own, not ours.
    const last = await this.attempts.findLatestForSchedule(scheduleId, { channel: 'auto_debit' });
    if (!last) return false;

    const installment = await this.plans.getInstallment(scheduleId);
    const plan = await this.plans.get(installment.customer_plan_id);
    const customer = await this.customers.get(plan.customer_id);

    if (last.payment_method === 'card') {
      return Boolean(customer.momo_phone) && isMomoProvider(customer.momo_provider ?? '');
    }
    if (last.payment_method === 'momo') {
      return Boolean(await this.cards.findUsable(customer.id));
    }
    return false;
  }
}
