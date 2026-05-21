export class CustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer "${id}" not found`);
    this.name = 'CustomerNotFoundError';
  }
}

export class GhanaCardNotAttachedError extends Error {
  constructor(id: string) {
    super(`Customer "${id}" has no Ghana Card attached to verify`);
    this.name = 'GhanaCardNotAttachedError';
  }
}

export class GhanaCardVerificationFailedError extends Error {
  constructor(reason: string | undefined) {
    super(`Ghana Card verification failed${reason ? `: ${reason}` : ''}`);
    this.name = 'GhanaCardVerificationFailedError';
  }
}
