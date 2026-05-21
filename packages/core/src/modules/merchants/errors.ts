export class MerchantNotFoundError extends Error {
  constructor(id: string) {
    super(`Merchant "${id}" not found`);
    this.name = 'MerchantNotFoundError';
  }
}

export class MerchantConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerchantConflictError';
  }
}
