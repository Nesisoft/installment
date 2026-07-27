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
