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
