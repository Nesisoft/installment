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

/** A plan can only default from `active`. */
export class PlanDefaultError extends Error {
  constructor(id: string, status: string) {
    super(`Plan ${id} cannot default from status "${status}"`);
    this.name = 'PlanDefaultError';
  }
}

/**
 * Refund-and-forgive asked of a plan whose seller has not been credited enough
 * to give the instalment back. Forgiving makes the seller bear the refund by
 * reversing what they were credited — and on a layaway plan before completion
 * (or a hybrid one past its deposit split) nothing, or not enough, has been. The
 * completion accrual would then credit them the full order for goods the
 * customer was refunded for. Re-collect it instead, or cancel the plan.
 */
export class InstallmentRefundNotForgivableError extends Error {
  constructor(scheduleId: string, creditedPesewas: number, refundPesewas: number) {
    super(
      `Installment ${scheduleId} cannot be refunded and forgiven: the seller has been credited ` +
        `${creditedPesewas} pesewas on this plan, less than the ${refundPesewas} being refunded. ` +
        `Refund and re-collect it instead.`,
    );
    this.name = 'InstallmentRefundNotForgivableError';
  }
}

/** Refund-and-re-collect asked of a plan that is not running or completed. */
export class InstallmentRefundNotRecollectableError extends Error {
  constructor(planId: string, status: string) {
    super(`Plan ${planId} is "${status}"; only an active or completed plan can re-collect.`);
    this.name = 'InstallmentRefundNotRecollectableError';
  }
}
