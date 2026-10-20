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

/**
 * A case closed as paid while its instalment is still owed. Closing does not
 * record a payment, and a closed case is never looked at again — so the debt
 * would be forgiven with nothing on record. Record the payment first.
 */
export class CaseNotSettledError extends Error {
  constructor(caseId: string, scheduleStatus: string) {
    super(
      `Collections case "${caseId}" cannot be closed as paid: its instalment is "${scheduleStatus}". Record the payment on the plan first.`,
    );
    this.name = 'CaseNotSettledError';
  }
}
