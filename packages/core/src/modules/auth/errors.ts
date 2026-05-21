/** Generic credentials failure — deliberately does not say which part was wrong. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
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
