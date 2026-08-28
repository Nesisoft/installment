/** The caller may not review that line (not theirs, or not delivered yet). */
export class ReviewNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewNotAllowedError';
  }
}

/** That order line already carries a review. */
export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewConflictError';
  }
}

/** The device token could not be registered as given. */
export class DeviceRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRegistrationError';
  }
}
