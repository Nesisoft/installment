export class StoreNotFoundError extends Error {
  constructor(idOrSlug: string) {
    super(`Store "${idOrSlug}" not found`);
    this.name = 'StoreNotFoundError';
  }
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

export class StoreTransitionError extends Error {
  constructor(from: string, event: string) {
    super(`Cannot "${event}" a store in status "${from}"`);
    this.name = 'StoreTransitionError';
  }
}
