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
