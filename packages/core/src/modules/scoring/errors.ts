export class ScoringDecisionNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`No scoring decision found for application ${applicationId}`);
    this.name = 'ScoringDecisionNotFoundError';
  }
}
