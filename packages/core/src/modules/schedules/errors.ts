export class CustomerPlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer plan ${id} not found`);
    this.name = 'CustomerPlanNotFoundError';
  }
}

/** The application is not in a state from which a plan can be activated. */
export class PlanActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanActivationError';
  }
}

/** A plan has already been activated for this application (idempotency guard). */
export class PlanAlreadyActiveError extends Error {
  constructor(applicationId: string) {
    super(`A plan has already been activated for application ${applicationId}`);
    this.name = 'PlanAlreadyActiveError';
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Installment schedule ${id} not found`);
    this.name = 'ScheduleNotFoundError';
  }
}

/** Optimistic-concurrency conflict: the row changed under us mid-transition. */
export class ScheduleConcurrencyError extends Error {
  constructor(id: string) {
    super(`Concurrent update detected on schedule ${id}`);
    this.name = 'ScheduleConcurrencyError';
  }
}

/** The installment is already paid or in a terminal state, so it can't be paid. */
export class InstallmentNotPayableError extends Error {
  constructor(id: string, status: string) {
    super(`Installment ${id} cannot be paid from status "${status}"`);
    this.name = 'InstallmentNotPayableError';
  }
}

/** A receipt only exists for a paid installment. */
export class ReceiptNotAvailableError extends Error {
  constructor(id: string, status: string) {
    super(`Installment ${id} has no receipt (status "${status}", not paid)`);
    this.name = 'ReceiptNotAvailableError';
  }
}
