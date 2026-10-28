import type { Order, OrderStatus } from '@installment/api-types';

/** The statuses the API lets staff cancel from (`OrdersService.cancel`). */
const CANCELLABLE: readonly OrderStatus[] = [
  'pending_payment',
  'pending_approval',
  'payment_failed',
];

/**
 * What staff can do to this order from the console. Confirming a payment is
 * for a pay-in-full order still waiting for its money; an instalment order's
 * money arrives through its plan. Cancelling is for an order nothing has been
 * paid on; once paid it needs a refund or a return, not a status change.
 */
export function orderActions(order: Pick<Order, 'status' | 'payment_type'>): {
  confirmPayment: boolean;
  cancel: boolean;
} {
  return {
    confirmPayment: order.status === 'pending_payment' && order.payment_type === 'full',
    cancel: CANCELLABLE.includes(order.status),
  };
}

/** Statuses for the list's filter, in the order an order moves through them. */
export const ORDER_STATUS_FILTERS: { value: OrderStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'payment_failed', label: 'Payment failed' },
  { value: 'pending_approval', label: 'Awaiting credit decision' },
  { value: 'paid', label: 'Paid' },
  { value: 'financing_active', label: 'On a plan' },
  { value: 'fulfilling', label: 'Confirmed by seller' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'declined', label: 'Declined' },
  { value: 'defaulted', label: 'Defaulted' },
];
