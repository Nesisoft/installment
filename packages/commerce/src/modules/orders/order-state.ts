import { InvalidOrderTransitionError } from './errors';

/**
 * The commerce order lifecycle. An order is created at checkout in one of two
 * entry states — `pending_payment` (pay-now / full) or `pending_approval`
 * (installment, awaiting the engine's underwriting decision) — and then walks
 * the fulfilment path. Financial state (paid / financing_active) is owned by
 * OrdersService; the fulfilment transitions (fulfilling → shipped → …) land in
 * a later slice but are defined here so the machine is complete.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'pending_approval',
  'paid',
  'financing_active',
  'fulfilling',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'payment_failed',
  'declined',
  'returned',
  'defaulted',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed next states for each order status. Terminal states map to `[]`. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['paid', 'payment_failed', 'cancelled'],
  pending_approval: ['financing_active', 'declined', 'cancelled'],
  paid: ['fulfilling', 'cancelled', 'returned'],
  financing_active: ['fulfilling', 'defaulted', 'cancelled'],
  fulfilling: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['completed', 'returned'],
  // retry the charge, or give up
  payment_failed: ['pending_payment', 'cancelled'],
  completed: [],
  cancelled: [],
  declined: [],
  returned: [],
  defaulted: [],
};

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Throws {@link InvalidOrderTransitionError} unless `from → to` is allowed. */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}
