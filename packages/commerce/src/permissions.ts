/**
 * RBAC permission names for the commerce layer. Mirrors the rows seeded in
 * db migration 0005_commerce_foundation.sql. Kept here (not in @installment/
 * core) so the commerce package owns its own authorization vocabulary; the
 * core RBAC guard checks these as plain strings.
 */
export const CATALOG_PERMISSIONS = {
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',
  CATEGORIES_WRITE: 'categories:write',
} as const;

export type CatalogPermission = (typeof CATALOG_PERMISSIONS)[keyof typeof CATALOG_PERMISSIONS];
