import type { BadgeTone } from '@installment/ui';
import type { RefundListRow, RefundQueue } from '@installment/api-types';

/** What each queue is called, and what it asks of whoever is reading it. */
export const REFUND_QUEUE_INFO: Record<
  RefundQueue,
  { label: string; detail: string; tone: BadgeTone; attention: boolean }
> = {
  to_send: {
    label: 'To send',
    detail: 'Waiting for the worker, which sends every 5 minutes. Send now to skip the wait.',
    tone: 'info',
    attention: false,
  },
  in_flight: {
    label: 'With Paystack',
    detail: 'Paystack accepted it. The reconciler records the outcome when Paystack has one.',
    tone: 'info',
    attention: false,
  },
  unresolved: {
    label: 'Unresolved',
    detail:
      'Sent, or possibly sent, with no answer. Never send it again — a second send is a second refund. Look the charge up in the Paystack dashboard; see docs/runbooks/refunds.md.',
    tone: 'warning',
    attention: true,
  },
  failed: {
    label: 'Refused by Paystack',
    detail: 'The customer is still owed. Pay them another way, then mark it paid by hand with how.',
    tone: 'danger',
    attention: true,
  },
  to_pay_by_hand: {
    label: 'To pay by hand',
    detail:
      'The money came in outside Paystack, so it goes back the same way. Mark it paid once it has.',
    tone: 'warning',
    attention: true,
  },
  paid: {
    label: 'Paid',
    detail: 'The customer has their money back.',
    tone: 'success',
    attention: false,
  },
};

export type RefundAction = 'send' | 'mark_paid' | 'mark_paid_after_check';

/**
 * The one thing a person can do about this refund, if any. Mirrors what the
 * API accepts: `send` only before anything was sent; a hand payment where
 * Paystack is not paying it; and for an unresolved one, a hand payment only
 * after looking the charge up in the Paystack dashboard and finding no refund.
 * Never for one Paystack has accepted: it is paying that one.
 */
export function refundAction(row: Pick<RefundListRow, 'queue'>): RefundAction | null {
  switch (row.queue) {
    case 'to_send':
      return 'send';
    case 'failed':
    case 'to_pay_by_hand':
      return 'mark_paid';
    case 'unresolved':
      return 'mark_paid_after_check';
    default:
      return null;
  }
}
