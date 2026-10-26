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

/**
 * A merchant tried to replace their payout account without the code sent to
 * the phone on file. Replacing one is how a borrowed or stolen session would
 * redirect every settlement, so a signed-in session alone is not enough.
 */
export class PayoutChangeCodeRequiredError extends Error {
  constructor() {
    super('Replacing your payout account needs the code we text to your phone');
    this.name = 'PayoutChangeCodeRequiredError';
  }
}

/**
 * The code was wrong, expired, used up its attempts, or was sent for a
 * different account — a code names the one destination it was asked for.
 */
export class PayoutChangeCodeInvalidError extends Error {
  constructor() {
    super('That code is wrong or has expired. Ask for a new one.');
    this.name = 'PayoutChangeCodeInvalidError';
  }
}

/** The chosen bank is not one Paystack can pay out to in Ghana. */
export class UnknownBankError extends Error {
  constructor(bankCode: string) {
    super(`Bank code "${bankCode}" is not a payout destination we can use`);
    this.name = 'UnknownBankError';
  }
}

/** A KYC document id that is not this merchant's, or not there at all. */
export class MerchantKycDocumentNotFoundError extends Error {
  constructor(id: string) {
    super(`KYC document "${id}" not found`);
    this.name = 'MerchantKycDocumentNotFoundError';
  }
}

/**
 * A merchant tried to replace a document a reviewer has already approved.
 *
 * Refused rather than allowed: a merchant who could swap an approved card for
 * something else would keep the activation the real card earned. Replacing one
 * takes a reviewer rejecting it first, which is a decision with a name on it.
 */
export class MerchantKycAlreadyApprovedError extends Error {
  constructor(docType: string) {
    super(`The ${docType} on file is already approved; ask support to reopen it before replacing`);
    this.name = 'MerchantKycAlreadyApprovedError';
  }
}

/** Activation attempted while required KYC documents are still outstanding. */
export class MerchantKycIncompleteError extends Error {
  constructor(outstanding: readonly string[]) {
    super(`Cannot activate: KYC is not complete (${outstanding.join(', ')})`);
    this.name = 'MerchantKycIncompleteError';
  }
}
