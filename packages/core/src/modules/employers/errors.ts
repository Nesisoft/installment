export class EmployerNotFoundError extends Error {
  constructor(id: string) {
    super(`Employer "${id}" not found`);
    this.name = 'EmployerNotFoundError';
  }
}

export class EmploymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Employment "${id}" not found`);
    this.name = 'EmploymentNotFoundError';
  }
}

export class DuplicateEmploymentError extends Error {
  constructor(customerId: string, employerId: string) {
    super(`Customer "${customerId}" is already linked to employer "${employerId}"`);
    this.name = 'DuplicateEmploymentError';
  }
}

/**
 * A change the link's current state does not allow: verifying or recording
 * payroll consent on a job the customer no longer holds, or linking a customer
 * to an employer whose partnership has ended.
 */
export class EmploymentNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmploymentNotAllowedError';
  }
}
