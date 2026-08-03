/**
 * Canonical permission names — must mirror the `permissions` rows seeded in
 * migrations 0002_users_and_rbac.sql and 0003_phase3_permissions.sql.
 * Format: 'resource:action'.
 */
export const PERMISSIONS = {
  MERCHANTS_READ: 'merchants:read',
  MERCHANTS_WRITE: 'merchants:write',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  EMPLOYERS_READ: 'employers:read',
  EMPLOYERS_WRITE: 'employers:write',
  APPLICATIONS_REVIEW: 'applications:review',
  COLLECTIONS_ACT: 'collections:act',
  PLANS_READ: 'plans:read',
  PLANS_WRITE: 'plans:write',
  /**
   * Record product delivery against a plan. Separate from PLANS_WRITE because
   * delivery is what releases a layaway merchant's reserve — it moves money,
   * while PLANS_WRITE means "create / update plan templates".
   */
  PLANS_DELIVER: 'plans:deliver',
  USERS_WRITE: 'users:write',
  AUDIT_READ: 'audit:read',
  /**
   * Trigger settlement runs and payout reconciliation — moving real money to
   * merchants. Previously these routes carried PLANS_WRITE, whose seeded
   * meaning is "create / update plan templates", so anyone able to edit a
   * template could also fire a payout batch.
   */
  SETTLEMENTS_RUN: 'settlements:run',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const PERMISSION_SET: ReadonlySet<string> = new Set(Object.values(PERMISSIONS));

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export class PermissionDeniedError extends Error {
  constructor(permission: string) {
    super(`Permission denied: "${permission}" is required`);
    this.name = 'PermissionDeniedError';
  }
}
