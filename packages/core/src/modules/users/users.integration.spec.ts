import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { UsersService } from './users.service';
import { RoleNotFoundError, UserConflictError, UserNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('UsersService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const users = new UsersService(db, new AuditLogger(), new PasswordService(4));
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const email = () => `staff+${randomUUID()}@ops.gh`;
  const phone = () => `+23324${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

  it('creates an admin with the admin role and resolves all seeded permissions', async () => {
    const created = await users.createStaff(
      {
        email: email(),
        name: 'Jane',
        password: 'longenough',
        user_type: 'admin',
        roleNames: ['admin'],
      },
      SYSTEM_ACTOR,
    );
    expect(created.user_type).toBe('admin');
    expect(created.password_hash).not.toBeNull();

    const perms = await users.getPermissions(created.id);
    expect(perms.has('merchants:write')).toBe(true);
    expect(perms.has('audit:read')).toBe(true);
    expect(perms.has('users:write')).toBe(true);
    // admin holds every seeded permission (8 from 0002 + 4 from 0003).
    expect(perms.size).toBe(12);
    expect(await users.getRoleNames(created.id)).toContain('admin');
  });

  it('finds a user by email (case-insensitive) and by id', async () => {
    const e = email();
    const created = await users.createStaff(
      { email: e, name: 'Kofi', password: 'longenough', user_type: 'agent', roleNames: ['ops'] },
      SYSTEM_ACTOR,
    );
    const byEmail = await users.findByEmail(e.toUpperCase());
    expect(byEmail?.id).toBe(created.id);
    expect((await users.getById(created.id)).id).toBe(created.id);
  });

  it('creates a customer user by phone with no password', async () => {
    const p = phone();
    const created = await users.createCustomerUser({ phone: p, name: 'Ama' }, SYSTEM_ACTOR);
    expect(created.user_type).toBe('customer');
    expect(created.password_hash).toBeNull();
    expect((await users.findByPhone(p))?.id).toBe(created.id);
    expect(await users.getRoleNames(created.id)).toContain('customer');
  });

  it('rejects a duplicate email with UserConflictError', async () => {
    const e = email();
    const input = { email: e, name: 'Dup', password: 'longenough', user_type: 'admin' as const };
    await users.createStaff(input, SYSTEM_ACTOR);
    await expect(users.createStaff(input, SYSTEM_ACTOR)).rejects.toBeInstanceOf(UserConflictError);
  });

  it('rejects assigning an unknown role', async () => {
    await expect(
      users.createStaff(
        {
          email: email(),
          name: 'X',
          password: 'longenough',
          user_type: 'admin',
          roleNames: ['wizard'],
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
  });

  it('assignRole is idempotent and additive', async () => {
    const created = await users.createStaff(
      {
        email: email(),
        name: 'Multi',
        password: 'longenough',
        user_type: 'agent',
        roleNames: ['ops'],
      },
      SYSTEM_ACTOR,
    );
    await users.assignRole(created.id, 'admin', SYSTEM_ACTOR);
    await users.assignRole(created.id, 'admin', SYSTEM_ACTOR); // no-op
    const roles = await users.getRoleNames(created.id);
    expect(roles.sort()).toEqual(['admin', 'ops']);
  });

  it('throws UserNotFoundError for unknown ids', async () => {
    await expect(users.getById(randomUUID())).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
