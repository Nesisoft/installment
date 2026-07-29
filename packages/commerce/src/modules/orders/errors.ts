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

export class InvalidOrderTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal order transition ${from} → ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}
