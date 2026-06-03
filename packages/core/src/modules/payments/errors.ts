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
