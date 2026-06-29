export class CollectionsCaseNotFoundError extends Error {
  constructor(id: string) {
    super(`Collections case "${id}" not found`);
    this.name = 'CollectionsCaseNotFoundError';
  }
}

export class CaseAlreadyClosedError extends Error {
  constructor(id: string) {
    super(`Collections case "${id}" is already closed`);
    this.name = 'CaseAlreadyClosedError';
  }
}
