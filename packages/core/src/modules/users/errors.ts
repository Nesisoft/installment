export class UserNotFoundError extends Error {
  constructor(idOrIdentifier: string) {
    super(`User "${idOrIdentifier}" not found`);
    this.name = 'UserNotFoundError';
  }
}

export class UserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConflictError';
  }
}

export class RoleNotFoundError extends Error {
  constructor(name: string) {
    super(`Role "${name}" not found`);
    this.name = 'RoleNotFoundError';
  }
}

/**
 * A role or account change that would hand a login the wrong kind of access,
 * leave the console with no administrator, or let staff change their own
 * access.
 */
export class UserAccessChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserAccessChangeError';
  }
}
