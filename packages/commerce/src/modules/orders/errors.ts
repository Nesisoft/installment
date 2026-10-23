export class AddressNotFoundError extends Error {
  constructor(id: string) {
    super(`Address "${id}" not found`);
    this.name = 'AddressNotFoundError';
  }
}

export class CartItemNotFoundError extends Error {
  constructor(variantId: string) {
    super(`Cart has no item for variant "${variantId}"`);
    this.name = 'CartItemNotFoundError';
  }
}

/** A variant/product cannot be added to a cart (missing, inactive, or archived). */
export class NotPurchasableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotPurchasableError';
  }
}

/** Checkout was attempted on an empty active cart. */
export class EmptyCartError extends Error {
  constructor() {
    super('Cannot check out an empty cart');
    this.name = 'EmptyCartError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Order "${id}" not found`);
    this.name = 'OrderNotFoundError';
  }
}

/**
 * A credit plan the caller cannot see.
 *
 * Thrown for another merchant's plan as well as for one that does not exist, so
 * the two are indistinguishable: a 403 would confirm the plan is real, which
 * turns uuid enumeration into a leak of who is lending to whom.
 */
export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Plan "${id}" not found`);
    this.name = 'PlanNotFoundError';
  }
}

/** Payment confirmation was attempted on an order not awaiting payment. */
export class OrderNotPayableError extends Error {
  constructor(id: string, status: string) {
    super(`Order "${id}" is "${status}", not awaiting payment`);
    this.name = 'OrderNotPayableError';
  }
}

/**
 * A charge for this order may still settle — a Mobile Money prompt not yet
 * answered — so another must not be started until it has.
 */
export class OrderPaymentInFlightError extends Error {
  constructor(id: string, reference: string) {
    super(`Order "${id}" has a payment in progress (${reference}); wait for it to finish`);
    this.name = 'OrderPaymentInFlightError';
  }
}

/** Financing activation was attempted on an order that isn't ready for it. */
export class OrderNotActivatableError extends Error {
  constructor(id: string, reason: string) {
    super(`Order "${id}" cannot activate financing: ${reason}`);
    this.name = 'OrderNotActivatableError';
  }
}

/**
 * Cancellation was attempted on an order that has already taken the customer's
 * money. ORDER_TRANSITIONS permits paid -> cancelled and financing_active ->
 * cancelled, but neither is a status flip: one needs the ledger reversed and
 * the money refunded, the other needs an active credit plan unwound. Refusing
 * is safer than a cancel that silently keeps the cash.
 */
export class OrderNotCancellableError extends Error {
  constructor(orderId: string, status: string) {
    super(`Order "${orderId}" cannot be cancelled from status "${status}"`);
    this.name = 'OrderNotCancellableError';
  }
}

export class InvalidOrderTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal order transition ${from} → ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}

/** The pickup hub named at checkout does not exist, or is no longer active. */
export class PickupHubNotFoundError extends Error {
  constructor(id: string) {
    super(`Pickup hub "${id}" not found`);
    this.name = 'PickupHubNotFoundError';
  }
}

/**
 * No active delivery zone matched, and there is no national fallback.
 *
 * Migration 0015 seeds a national row precisely so a quote is always
 * answerable, so reaching this means the configuration has been removed. It is
 * left to surface as a 5xx on purpose: the alternative is charging nothing and
 * absorbing every delivery silently, and ops needs to know immediately.
 */
export class DeliveryZoneNotConfiguredError extends Error {
  constructor() {
    super('No active delivery zone is configured (expected a national fallback)');
    this.name = 'DeliveryZoneNotConfiguredError';
  }
}

/**
 * The order is not in a state that allows this fulfilment step.
 *
 * Also what a lost optimistic-update race produces: every fulfilment write
 * guards on the status it read, so a concurrent writer turns into this rather
 * than a silent double transition.
 */
export class OrderNotFulfillableError extends Error {
  constructor(orderId: string, status: string, attempted: string) {
    super(`Order "${orderId}" is "${status}" and cannot be marked ${attempted}`);
    this.name = 'OrderNotFulfillableError';
  }
}
