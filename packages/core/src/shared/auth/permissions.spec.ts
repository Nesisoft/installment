import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PermissionDeniedError, isPermission } from './permissions';

describe('permissions', () => {
  it('mirrors the engine permission names seeded in migrations 0002 + 0003', () => {
    // Commerce permissions (catalog:*, categories:*) live in @installment/commerce.
    expect(Object.values(PERMISSIONS).sort()).toEqual(
      [
        'applications:review',
        'audit:read',
        'collections:act',
        'customers:read',
        'customers:write',
        'employers:read',
        'employers:write',
        'merchants:read',
        'merchants:write',
        'plans:read',
        'plans:write',
        'users:write',
      ].sort(),
    );
  });

  it('isPermission recognises known names and rejects others', () => {
    expect(isPermission('merchants:write')).toBe(true);
    expect(isPermission('merchants:delete')).toBe(false);
    expect(isPermission('')).toBe(false);
  });

  it('PermissionDeniedError names the required permission', () => {
    expect(new PermissionDeniedError('plans:write').message).toMatch(/plans:write/);
  });
});
