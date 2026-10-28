export class CategoryNotFoundError extends Error {
  constructor(idOrSlug: string) {
    super(`Category "${idOrSlug}" not found`);
    this.name = 'CategoryNotFoundError';
  }
}

export class CategoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryConflictError';
  }
}

export class CategoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryValidationError';
  }
}

export class ProductNotFoundError extends Error {
  constructor(id: string) {
    super(`Product "${id}" not found`);
    this.name = 'ProductNotFoundError';
  }
}

export class ProductConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductConflictError';
  }
}

/**
 * A seller, or anyone, trying to put a product staff took down back on sale.
 * The takedown is lifted by staff, not by changing the status.
 */
export class ProductTakenDownError extends Error {
  constructor(id: string, reason: string) {
    super(
      `Product "${id}" was taken down by Ejua and cannot be published until that is lifted. Reason: ${reason}`,
    );
    this.name = 'ProductTakenDownError';
  }
}

export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductValidationError';
  }
}

export class VariantNotFoundError extends Error {
  constructor(id: string) {
    super(`Product variant "${id}" not found`);
    this.name = 'VariantNotFoundError';
  }
}

export class InsufficientStockError extends Error {
  constructor(variantId: string, requested: number, available: number) {
    super(`Variant "${variantId}" has ${available} available, cannot reserve ${requested}`);
    this.name = 'InsufficientStockError';
  }
}
