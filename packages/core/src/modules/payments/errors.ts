export class PaymentAttemptNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment attempt ${id} not found`);
    this.name = 'PaymentAttemptNotFoundError';
  }
}

/** The installment isn't in a state a charge can be initiated from. */
export class InstallmentNotChargeableError extends Error {
  constructor(id: string, status: string) {
    super(`Installment ${id} cannot be charged from status "${status}"`);
    this.name = 'InstallmentNotChargeableError';
  }
}

/**
 * A charge for this installment is already in flight — a second one would
 * debit the customer twice. Raised both when an unresolved attempt exists and
 * when the per-schedule charge lock is already held. Callers should surface
 * this as a conflict, not an error: the first charge is still running.
 */
export class ChargeAlreadyInFlightError extends Error {
  constructor(scheduleId: string, reason: string) {
    super(`A charge for installment ${scheduleId} is already in flight (${reason})`);
    this.name = 'ChargeAlreadyInFlightError';
  }
}
