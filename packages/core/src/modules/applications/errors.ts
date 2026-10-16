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

/**
 * The plan applied for is not on offer: withdrawn by staff, outside its
 * effective window, or no such template.
 */
export class PlanNotOfferedError extends Error {
  constructor(
    readonly planTemplateId: string,
    readonly reason: 'not_found' | 'inactive' | 'not_yet_effective' | 'expired',
  ) {
    super(`Plan template "${planTemplateId}" is not on offer (${reason})`);
    this.name = 'PlanNotOfferedError';
  }
}
