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

/** Payment confirmation was attempted on an order not awaiting payment. */
export class OrderNotPayableError extends Error {
  constructor(id: string, status: string) {
    super(`Order "${id}" is "${status}", not awaiting payment`);
    this.name = 'OrderNotPayableError';
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
