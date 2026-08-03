import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PermissionDeniedError, isPermission } from './permissions';

describe('permissions', () => {
  it('mirrors the engine permission names seeded in migrations 0002 + 0003 + 0009 + 0010 + 0011', () => {
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
        // 0010 — recording delivery releases a layaway merchant's reserve, so
        // it moves money too.
        'plans:deliver',
        // 0009 — settlement runs are money movement and need their own grant,
        // rather than riding on plans:write ('create / update plan templates').
        'settlements:run',
        // 0011 — a refund sends customer money out of the platform account,
        // which collections:act ('take action on collections cases') is not.
        'refunds:act',
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
