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
