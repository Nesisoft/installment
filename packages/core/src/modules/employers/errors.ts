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
