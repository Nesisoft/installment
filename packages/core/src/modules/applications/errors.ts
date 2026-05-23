export class ApplicationNotFoundError extends Error {
  constructor(id: string) {
    super(`Application "${id}" not found`);
    this.name = 'ApplicationNotFoundError';
  }
}

export class DuplicateApplicationError extends Error {
  constructor(merchantId: string, orderReference: string) {
    super(`Application already exists for merchant "${merchantId}" order "${orderReference}"`);
    this.name = 'DuplicateApplicationError';
  }
}
