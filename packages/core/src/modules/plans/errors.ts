export class PlanTemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Plan template "${id}" not found`);
    this.name = 'PlanTemplateNotFoundError';
  }
}

export class PlanTemplateInactiveError extends Error {
  constructor(id: string) {
    super(`Plan template "${id}" is not active`);
    this.name = 'PlanTemplateInactiveError';
  }
}
