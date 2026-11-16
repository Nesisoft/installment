import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { PERMISSIONS } from '../../shared/auth/permissions';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { UsersService } from './users.service';
import {
  RoleNotFoundError,
  UserAccessChangeError,
  UserConflictError,
  UserNotFoundError,
} from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('UsersService (integration)', () => {
  const { db, pool } = createTestDb();
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

    // The password was chosen by whoever created the account, so it holds
    // nothing until its owner picks their own.
    expect(created.must_change_password).toBe(true);
    expect((await users.getPermissions(created.id)).size).toBe(0);
    await users.changeOwnPassword(created.id, 'mine-now-1', {
      actorId: created.id,
      actorType: 'admin',
    });

    const perms = await users.getPermissions(created.id);
    // admin holds every engine permission (0002 + 0003). Commerce permissions
    // (catalog:*, seeded by 0005) are granted to admin too and covered in the
    // @installment/commerce tests, so the total may exceed the engine set.
    for (const perm of Object.values(PERMISSIONS)) {
      expect(perms.has(perm)).toBe(true);
    }
    expect(perms.size).toBeGreaterThanOrEqual(Object.values(PERMISSIONS).length);
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

  const as = (id: string) => ({ actorId: id, actorType: 'admin' as const });
  /** A member of staff who has signed in and chosen their own password. */
  const staff = async (roleNames: string[], user_type: 'admin' | 'agent' = 'admin') => {
    const created = await users.createStaff(
      {
        email: email(),
        name: `Staff ${randomUUID().slice(0, 6)}`,
        password: 'longenough',
        user_type,
        roleNames,
      },
      SYSTEM_ACTOR,
    );
    return users.changeOwnPassword(created.id, 'their-own-1', as(created.id));
  };
  const lastAudit = async (id: string) => {
    const [row] = await db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, id))
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return row;
  };

  // Permissions come only from roles and no route checks the kind of login,
  // so `admin` on a merchant login was the whole console.
  it('gives each role only to the kind of login it is for', async () => {
    const merchant = await users.createMerchantUser(
      { email: email(), name: 'Seller', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    await expect(users.assignRole(merchant.id, 'admin', SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    await expect(
      users.createMerchantUser(
        { email: email(), name: 'Seller', password: 'longenough', roleNames: ['ops'] },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(UserAccessChangeError);
    const agent = await staff(['ops'], 'agent');
    await expect(users.assignRole(agent.id, 'merchant_owner', SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    expect(await users.getRoleNames(merchant.id)).toEqual(['merchant_owner']);
  });

  it('does not let staff change their own access', async () => {
    const admin = await staff(['admin']);
    await expect(users.assignRole(admin.id, 'ops', as(admin.id))).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    await expect(users.revokeRole(admin.id, 'admin', as(admin.id))).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    await expect(
      users.setActive(admin.id, false, { reason: 'Leaving' }, as(admin.id)),
    ).rejects.toBeInstanceOf(UserAccessChangeError);
  });

  it('revokes a role, and the permissions with it, on the next check', async () => {
    const lead = await staff(['admin']);
    const agent = await staff(['ops', 'admin'], 'agent');
    expect((await users.getPermissions(agent.id)).has(PERMISSIONS.USERS_WRITE)).toBe(true);
    await users.revokeRole(agent.id, 'admin', as(lead.id));
    await users.revokeRole(agent.id, 'admin', as(lead.id)); // nothing left to revoke
    expect(await users.getRoleNames(agent.id)).toEqual(['ops']);
    expect((await users.getPermissions(agent.id)).has(PERMISSIONS.USERS_WRITE)).toBe(false);
  });

  // Tokens are checked for their signature only, so without this a member of
  // staff switched off kept every permission until their token ran out.
  it('switches an account off so it holds no permissions, and back on', async () => {
    const lead = await staff(['admin']);
    const agent = await staff(['ops'], 'agent');
    expect((await users.getPermissions(agent.id)).size).toBeGreaterThan(0);

    const off = await users.setActive(agent.id, false, { reason: 'Left the company' }, as(lead.id));
    expect(off.is_active).toBe(false);
    expect('password_hash' in off).toBe(false);
    expect((await users.getPermissions(agent.id)).size).toBe(0);

    await users.setActive(agent.id, true, { reason: 'Rehired' }, as(lead.id));
    expect((await users.getPermissions(agent.id)).size).toBeGreaterThan(0);

    const customer = await users.createCustomerUser({ phone: phone(), name: 'Ama' }, SYSTEM_ACTOR);
    await expect(
      users.setActive(customer.id, false, { reason: 'Test' }, as(lead.id)),
    ).rejects.toBeInstanceOf(UserAccessChangeError);
  });

  it('never leaves the console without an active administrator', async () => {
    // Make the two admins created here the only active ones, then put every
    // other admin back. Files run one at a time per worker database.
    const others = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.user_roles, eq(schema.user_roles.user_id, schema.users.id))
      .innerJoin(schema.roles, eq(schema.roles.id, schema.user_roles.role_id))
      .where(and(eq(schema.roles.name, 'admin'), eq(schema.users.is_active, true)));
    const otherIds = others.map((o) => o.id);
    const a = await staff(['admin']);
    const b = await staff(['admin']);
    if (otherIds.length) {
      await db
        .update(schema.users)
        .set({ is_active: false })
        .where(inArray(schema.users.id, otherIds));
    }
    try {
      // B may remove A's admin role while B is still an admin…
      await users.revokeRole(a.id, 'admin', as(b.id));
      // …but now B is the last one, and nobody may remove that.
      await expect(users.revokeRole(b.id, 'admin', as(a.id))).rejects.toBeInstanceOf(
        UserAccessChangeError,
      );
      await expect(
        users.setActive(b.id, false, { reason: 'Leaving' }, as(a.id)),
      ).rejects.toBeInstanceOf(UserAccessChangeError);
      // Switching off an account that is not an admin is unaffected.
      await users.setActive(a.id, false, { reason: 'Leaving' }, as(b.id));
    } finally {
      if (otherIds.length) {
        await db
          .update(schema.users)
          .set({ is_active: sql`true` })
          .where(inArray(schema.users.id, otherIds));
      }
    }
  });

  it('lists staff with their roles, and the roles staff can hold', async () => {
    const agent = await staff(['ops'], 'agent');
    const list = await users.listStaff();
    expect(list.find((m) => m.id === agent.id)).toMatchObject({
      user_type: 'agent',
      is_active: true,
      must_change_password: false,
      roles: ['ops'],
    });
    expect(list.every((m) => m.user_type === 'admin' || m.user_type === 'agent')).toBe(true);
    const roles = await users.listStaffRoles();
    expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(['admin', 'ops']));
    expect(roles.map((r) => r.name)).not.toContain('merchant_owner');
    expect(roles.find((r) => r.name === 'ops')?.permissions).toContain(PERMISSIONS.COLLECTIONS_ACT);
  });

  it('throws UserNotFoundError for unknown ids', async () => {
    await expect(users.getById(randomUUID())).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("changes the owner's password: no longer temporary, a new token version, audited", async () => {
    const created = await users.createStaff(
      { email: email(), name: 'Abena', password: 'longenough', user_type: 'agent' },
      SYSTEM_ACTOR,
    );
    expect(created.token_version).toBe(0);

    const changed = await users.changeOwnPassword(created.id, 'brand-new-1', as(created.id));
    expect(changed.must_change_password).toBe(false);
    expect(changed.token_version).toBe(1);
    expect(changed.password_changed_at).not.toBeNull();
    expect(changed.password_hash).not.toBe(created.password_hash);
    const audit = await lastAudit(created.id);
    expect(audit).toMatchObject({ event_type: 'user.password_changed', actor_id: created.id });
    expect(JSON.stringify(audit)).not.toContain('brand-new-1');
  });

  it('resets a member of staff to a temporary password that holds nothing', async () => {
    const lead = await staff(['admin']);
    const agent = await staff(['ops'], 'agent');
    expect((await users.getPermissions(agent.id)).size).toBeGreaterThan(0);

    await users.resetStaffPassword(
      agent.id,
      { temporary_password: 'Temp-Pass-123', reason: 'Forgot it' },
      as(lead.id),
    );

    const after = await users.getById(agent.id);
    expect(after.must_change_password).toBe(true);
    expect(after.token_version).toBe(agent.token_version + 1);
    expect((await users.getPermissions(agent.id)).size).toBe(0);
    expect((await users.listStaff()).find((m) => m.id === agent.id)?.must_change_password).toBe(
      true,
    );
    const audit = await lastAudit(agent.id);
    expect(audit).toMatchObject({
      event_type: 'user.password_reset',
      actor_id: lead.id,
      reason: 'Forgot it',
    });
    expect(JSON.stringify(audit)).not.toContain('Temp-Pass-123');

    // The owner choosing their own gives everything back.
    await users.changeOwnPassword(agent.id, 'agents-own-1', as(agent.id));
    expect((await users.getPermissions(agent.id)).size).toBeGreaterThan(0);
  });

  it('resets only other staff, never yourself and never a seller or shopper', async () => {
    const lead = await staff(['admin']);
    const reset = { temporary_password: 'Temp-Pass-123', reason: 'Forgot it' };
    await expect(users.resetStaffPassword(lead.id, reset, as(lead.id))).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    const merchant = await users.createMerchantUser(
      { email: email(), name: 'Seller', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    await expect(users.resetStaffPassword(merchant.id, reset, as(lead.id))).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    const customer = await users.createCustomerUser({ phone: phone(), name: 'Ama' }, SYSTEM_ACTOR);
    await expect(users.resetStaffPassword(customer.id, reset, as(lead.id))).rejects.toBeInstanceOf(
      UserAccessChangeError,
    );
    await expect(users.resetStaffPassword(randomUUID(), reset, as(lead.id))).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
    // Nothing was written to the seller's login.
    expect((await users.getById(merchant.id)).token_version).toBe(0);
  });
});
