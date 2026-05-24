export class PaymentAttemptNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment attempt ${id} not found`);
    this.name = 'PaymentAttemptNotFoundError';
  }
}
