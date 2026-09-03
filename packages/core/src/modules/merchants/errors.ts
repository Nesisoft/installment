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

/**
 * The bank would not confirm who owns the account.
 *
 * Refusing here is deliberate: an unconfirmed account is one whose owner we do
 * not know, and the whole point of letting a merchant enter their own details
 * is that a typo lands on a stranger's *name*, which they can see and correct,
 * rather than on a successful transfer to a stranger's account. An admin can
 * still attach a recipient code directly when a bank cannot be resolved.
 */
export class PayoutAccountUnresolvedError extends Error {
  constructor(reason: string) {
    super(`Could not confirm the account with the bank: ${reason}`);
    this.name = 'PayoutAccountUnresolvedError';
  }
}

/** The chosen bank is not one Paystack can pay out to in Ghana. */
export class UnknownBankError extends Error {
  constructor(bankCode: string) {
    super(`Bank code "${bankCode}" is not a payout destination we can use`);
    this.name = 'UnknownBankError';
  }
}
