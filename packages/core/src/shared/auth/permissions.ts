/**
 * Canonical permission names — must mirror the `permissions` rows seeded in
 * migration 0002_users_and_rbac.sql. Format: 'resource:action'.
 */
export const PERMISSIONS = {
  MERCHANTS_READ: 'merchants:read',
  MERCHANTS_WRITE: 'merchants:write',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  APPLICATIONS_REVIEW: 'applications:review',
  COLLECTIONS_ACT: 'collections:act',
  PLANS_WRITE: 'plans:write',
  AUDIT_READ: 'audit:read',
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
