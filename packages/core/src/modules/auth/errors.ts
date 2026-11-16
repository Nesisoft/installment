/** Generic credentials failure — deliberately does not say which part was wrong. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * The current password given when changing it was wrong.
 *
 * Not `InvalidCredentialsError`, because that answers 401 and every client
 * reads a 401 as "the session is over" and signs out. Someone who mistypes
 * their current password on the change form is still signed in.
 */
export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super('Your current password is not right');
    this.name = 'CurrentPasswordIncorrectError';
  }
}

export class AccountInactiveError extends Error {
  constructor() {
    super('Account is inactive');
    this.name = 'AccountInactiveError';
  }
}

export class InvalidOtpError extends Error {
  constructor() {
    super('Invalid or expired one-time passcode');
    this.name = 'InvalidOtpError';
  }
}

export class InvalidTokenError extends Error {
  constructor() {
    super('Invalid or expired token');
    this.name = 'InvalidTokenError';
  }
}

/**
 * Signup was attempted for a phone that already has a login.
 *
 * This does confirm to an unauthenticated caller that a number is registered.
 * The alternative — a silent success that sends a code which then fails — is
 * worse: it strands a real customer who simply forgot they had an account, and
 * it still burns an SMS. Rate limiting is what makes enumeration expensive.
 */
export class PhoneAlreadyRegisteredError extends Error {
  constructor() {
    super('That number already has an account. Sign in instead.');
    this.name = 'PhoneAlreadyRegisteredError';
  }
}

/**
 * Merchant signup was attempted with an email that already has a login.
 *
 * Same trade-off as the phone above: it confirms the address is registered, and
 * the alternative — accepting the signup and failing on a unique violation
 * after the merchant row is written — leaves an orphaned business behind. Rate
 * limiting is what makes enumeration expensive.
 */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('That email already has an account. Sign in instead.');
    this.name = 'EmailAlreadyRegisteredError';
  }
}
