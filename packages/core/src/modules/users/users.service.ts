import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction, type TransactionalTx } from '../../shared/event-bus/transaction';
import { PasswordService } from '../../shared/auth/password.service';
import {
  createCustomerUserSchema,
  createMerchantUserSchema,
  createStaffSchema,
  setUserActiveSchema,
  type CreateCustomerUserInput,
  type CreateMerchantUserInput,
  type CreateStaffInput,
} from './dto';
import {
  RoleNotFoundError,
  UserAccessChangeError,
  UserConflictError,
  UserNotFoundError,
} from './errors';
import { placeholderEmailFor } from '../customers/placeholder-email';

const u = schema.users;
const ur = schema.user_roles;
const r = schema.roles;
const rp = schema.role_permissions;
const perm = schema.permissions;

export type User = typeof schema.users.$inferSelect;

export interface UserActor {
  actorId: string;
  actorType: AuditActorType;
}

/** The logins that work the console. */
export const STAFF_USER_TYPES = ['admin', 'agent'] as const;

/**
 * Which kinds of login may hold each role.
 *
 * Permissions come only from roles, and nothing at the route level checks the
 * kind of login, so before this a merchant or customer login could be granted
 * `admin` and would have had the whole console API. A role not named here is
 * treated as a staff role.
 */
const ROLE_HOLDERS: Record<string, readonly string[]> = {
  admin: STAFF_USER_TYPES,
  ops: STAFF_USER_TYPES,
  merchant_owner: ['merchant'],
  customer: ['customer'],
  system: ['system'],
};
const holdersOf = (role: string): readonly string[] => ROLE_HOLDERS[role] ?? STAFF_USER_TYPES;

/** The role that can manage access; at least one active login must keep it. */
const ADMIN_ROLE = 'admin';

/** One member of staff, as the console lists them. */
export interface StaffMember {
  id: string;
  email: string;
  name: string;
  user_type: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
}

/** A role staff can be given, and what it allows. */
export interface StaffRole {
  name: string;
  description: string | null;
  permissions: string[];
  /** Active staff who hold it. */
  holders: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string): string | null => (UUID_RE.test(v) ? v : null);

export class UsersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    private readonly passwords: PasswordService,
  ) {}

  async createStaff(rawInput: unknown, actor: UserActor): Promise<User> {
    const input: CreateStaffInput = createStaffSchema.parse(rawInput);
    const passwordHash = await this.passwords.hash(input.password);
    return this.insertUser(
      {
        email: input.email,
        name: input.name,
        password_hash: passwordHash,
        user_type: input.user_type,
      },
      input.roleNames ?? [],
      actor,
    );
  }

  async createMerchantUser(rawInput: unknown, actor: UserActor): Promise<User> {
    const input: CreateMerchantUserInput = createMerchantUserSchema.parse(rawInput);
    const passwordHash = await this.passwords.hash(input.password);
    // The merchant link lives in metadata.merchant_id (no dedicated column yet);
    // getMerchantScope reads it to scope the /merchant portal to one merchant.
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.merchant_id ? { merchant_id: input.merchant_id } : {}),
    };
    return this.insertUser(
      {
        email: input.email,
        name: input.name,
        password_hash: passwordHash,
        user_type: 'merchant',
        metadata,
      },
      input.roleNames ?? ['merchant_owner'],
      actor,
    );
  }

  /**
   * The merchant a login is scoped to (from metadata.merchant_id), or null when
   * the user is not a merchant or has no merchant linked. Used by the merchant
   * portal guard to resolve the caller's own merchant id.
   */
  async getMerchantScope(userId: string): Promise<string | null> {
    const user = await this.getById(userId);
    if (user.user_type !== 'merchant') return null;
    const merchantId = (user.metadata as { merchant_id?: unknown } | null)?.merchant_id;
    return typeof merchantId === 'string' ? merchantId : null;
  }

  async createCustomerUser(rawInput: unknown, actor: UserActor): Promise<User> {
    const input: CreateCustomerUserInput = createCustomerUserSchema.parse(rawInput);
    return this.insertUser(
      {
        // Customers authenticate by phone+OTP, so a synthetic unique email keeps
        // the NOT NULL/UNIQUE email column satisfied without a real inbox.
        email: input.email ?? placeholderEmailFor(input.phone),
        name: input.name,
        phone: input.phone,
        user_type: 'customer',
        metadata: input.metadata ?? {},
      },
      input.roleNames ?? ['customer'],
      actor,
      input.phone,
    );
  }

  async getById(id: string): Promise<User> {
    const rows = await this.db
      .select()
      .from(u)
      .where(and(eq(u.id, id), isNull(u.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new UserNotFoundError(id);
    return row;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const rows = await this.db
      .select()
      .from(u)
      .where(and(eq(u.email, email), isNull(u.deleted_at)))
      .limit(1);
    return rows[0];
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    const rows = await this.db
      .select()
      .from(u)
      .where(and(eq(u.phone, phone), isNull(u.deleted_at)))
      .limit(1);
    return rows[0];
  }

  async assignRole(userId: string, roleName: string, actor: UserActor): Promise<void> {
    if (userId === actor.actorId) {
      throw new UserAccessChangeError(
        'You cannot change your own roles; ask another administrator',
      );
    }
    await runInTransaction(this.db, async (tx) => {
      await this.assignRolesTx(tx, userId, [roleName], actor);
      await this.audit.append(tx, {
        entityType: 'user',
        entityId: userId,
        eventType: 'user.role_assigned',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { role: roleName },
      });
    });
  }

  /** Distinct permission names granted to the user through their roles. */
  /**
   * Distinct permission names granted to the user through their roles — none
   * at all once the account is switched off or deleted.
   *
   * Access tokens are checked only for their signature and live for fifteen
   * minutes, so without the account check a deactivated member of staff kept
   * every permission until their token ran out. The guard asks this on every
   * request, so switching an account off now takes effect on the next one.
   */
  async getPermissions(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ name: perm.name })
      .from(ur)
      .innerJoin(u, eq(u.id, ur.user_id))
      .innerJoin(rp, eq(rp.role_id, ur.role_id))
      .innerJoin(perm, eq(perm.id, rp.permission_id))
      .where(and(eq(ur.user_id, userId), eq(u.is_active, true), isNull(u.deleted_at)));
    return new Set(rows.map((x) => x.name));
  }

  async getRoleNames(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: r.name })
      .from(ur)
      .innerJoin(r, eq(r.id, ur.role_id))
      .where(eq(ur.user_id, userId));
    return rows.map((x) => x.name);
  }

  /** Everyone who works the console, active first, with their roles. */
  async listStaff(): Promise<StaffMember[]> {
    const rows = await this.db
      .select({
        id: u.id,
        email: u.email,
        name: u.name,
        user_type: u.user_type,
        is_active: u.is_active,
        last_login_at: u.last_login_at,
        created_at: u.created_at,
        // Spelled out: with no join in the outer query, drizzle drops the table
        // from column names, and a bare "id" here would bind to roles.id.
        roles: sql<string[]>`coalesce(
          (SELECT array_agg(ro.name ORDER BY ro.name) FROM user_roles ura
           JOIN roles ro ON ro.id = ura.role_id WHERE ura.user_id = users.id),
          '{}')`,
      })
      .from(u)
      .where(and(inArray(u.user_type, [...STAFF_USER_TYPES]), isNull(u.deleted_at)))
      .orderBy(desc(u.is_active), asc(u.name), asc(u.id));
    return rows;
  }

  /** The roles staff can be given, with what each allows and who holds it. */
  async listStaffRoles(): Promise<StaffRole[]> {
    const rows = await this.db
      .select({
        name: r.name,
        description: r.description,
        // Qualified by hand, as in listStaff.
        permissions: sql<string[]>`coalesce(
          (SELECT array_agg(pe.name ORDER BY pe.name) FROM role_permissions rpa
           JOIN permissions pe ON pe.id = rpa.permission_id WHERE rpa.role_id = roles.id),
          '{}')`,
        holders: sql<number>`(
          SELECT count(*)::int FROM user_roles ura JOIN users us ON us.id = ura.user_id
          WHERE ura.role_id = roles.id AND us.is_active AND us.deleted_at IS NULL)`,
      })
      .from(r)
      .orderBy(asc(r.name));
    return rows.filter((row) => holdersOf(row.name).some((t) => t === 'admin' || t === 'agent'));
  }

  /**
   * Take a role away.
   *
   * Refuses the caller's own roles, and refuses to leave the console with no
   * active administrator — after that nobody could grant access back without
   * the database.
   */
  async revokeRole(userId: string, roleName: string, actor: UserActor): Promise<void> {
    if (userId === actor.actorId) {
      throw new UserAccessChangeError(
        'You cannot change your own roles; ask another administrator',
      );
    }
    await runInTransaction(this.db, async (tx) => {
      await this.lockAccessChanges(tx);
      const [role] = await tx.select({ id: r.id }).from(r).where(eq(r.name, roleName)).limit(1);
      if (!role) throw new RoleNotFoundError(roleName);
      if (roleName === ADMIN_ROLE) await this.assertAnotherAdmin(tx, userId);
      const removed = await tx
        .delete(ur)
        .where(and(eq(ur.user_id, userId), eq(ur.role_id, role.id)))
        .returning({ user_id: ur.user_id });
      if (removed.length === 0) return;
      await this.audit.append(tx, {
        entityType: 'user',
        entityId: userId,
        eventType: 'user.role_revoked',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { role: roleName },
      });
    });
  }

  /**
   * Switch a staff account off, or back on. Off, the account cannot sign in or
   * refresh, and holds no permissions from the next request.
   */
  async setActive(
    userId: string,
    active: boolean,
    rawInput: unknown,
    actor: UserActor,
  ): Promise<Omit<User, 'password_hash'>> {
    const { reason } = setUserActiveSchema.parse(rawInput);
    if (userId === actor.actorId) {
      throw new UserAccessChangeError('You cannot switch your own account off or on');
    }
    return runInTransaction(this.db, async (tx) => {
      await this.lockAccessChanges(tx);
      const [current] = await tx
        .select()
        .from(u)
        .where(and(eq(u.id, userId), isNull(u.deleted_at)))
        .for('update')
        .limit(1);
      if (!current) throw new UserNotFoundError(userId);
      if (!(STAFF_USER_TYPES as readonly string[]).includes(current.user_type)) {
        throw new UserAccessChangeError('Only staff accounts are managed here');
      }
      if (current.is_active === active) {
        const { password_hash: _omit, ...same } = current;
        return same;
      }
      if (!active) {
        const roles = await tx
          .select({ name: r.name })
          .from(ur)
          .innerJoin(r, eq(r.id, ur.role_id))
          .where(eq(ur.user_id, userId));
        if (roles.some((x) => x.name === ADMIN_ROLE)) await this.assertAnotherAdmin(tx, userId);
      }
      const [row] = await tx
        .update(u)
        .set({ is_active: active, updated_at: new Date().toISOString() })
        .where(eq(u.id, userId))
        .returning();
      await this.audit.append(tx, {
        entityType: 'user',
        entityId: userId,
        eventType: active ? 'user.reactivated' : 'user.deactivated',
        fromState: current.is_active ? 'active' : 'inactive',
        toState: active ? 'active' : 'inactive',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
      });
      const { password_hash: _omit, ...safe } = row!;
      return safe;
    });
  }

  async recordLogin(userId: string): Promise<void> {
    await this.db
      .update(u)
      .set({ last_login_at: new Date().toISOString() })
      .where(eq(u.id, userId));
  }

  // --------------------------------------------------------------- internals

  private async insertUser(
    values: typeof u.$inferInsert,
    roleNames: string[],
    actor: UserActor,
    /**
     * When creating a customer login, the (canonicalised) phone of the domain
     * record to bind to. The link is established once here and only claims an
     * as-yet-unlinked customer — a recycled number can never steal one already
     * bound to another login.
     */
    linkCustomerByPhone?: string,
  ): Promise<User> {
    return runInTransaction(this.db, async (tx) => {
      let row: User;
      try {
        const inserted = await tx.insert(u).values(values).returning();
        row = inserted[0]!;
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') {
          throw new UserConflictError('A user with that email or phone already exists');
        }
        throw err;
      }

      await this.assignRolesTx(tx, row.id, roleNames, actor);
      if (linkCustomerByPhone) {
        await tx
          .update(schema.customers)
          .set({ user_id: row.id })
          .where(
            and(eq(schema.customers.phone, linkCustomerByPhone), isNull(schema.customers.user_id)),
          );
      }
      await this.audit.append(tx, {
        entityType: 'user',
        entityId: row.id,
        eventType: 'user.created',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { user_type: row.user_type, roles: roleNames },
      });
      return row;
    });
  }

  private async assignRolesTx(
    tx: TransactionalTx,
    userId: string,
    roleNames: string[],
    actor: UserActor,
  ): Promise<void> {
    if (roleNames.length === 0) return;
    const [holder] = await tx
      .select({ user_type: u.user_type })
      .from(u)
      .where(eq(u.id, userId))
      .limit(1);
    if (!holder) throw new UserNotFoundError(userId);
    for (const roleName of roleNames) {
      const found = await tx.select({ id: r.id }).from(r).where(eq(r.name, roleName)).limit(1);
      const role = found[0];
      if (!role) throw new RoleNotFoundError(roleName);
      if (!holdersOf(roleName).includes(holder.user_type)) {
        throw new UserAccessChangeError(
          `The ${roleName} role cannot be given to a ${holder.user_type} login`,
        );
      }
      await tx
        .insert(ur)
        .values({ user_id: userId, role_id: role.id, granted_by: uuidOrNull(actor.actorId) })
        .onConflictDoNothing();
    }
  }

  /**
   * Serialises changes that take access away, so two administrators removing
   * each other at the same moment cannot both pass the last-admin check.
   */
  private async lockAccessChanges(tx: TransactionalTx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('users:access'))`);
  }

  /** Refuses when `userId` is the only active login holding the admin role. */
  private async assertAnotherAdmin(tx: TransactionalTx, userId: string): Promise<void> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ur)
      .innerJoin(r, eq(r.id, ur.role_id))
      .innerJoin(u, eq(u.id, ur.user_id))
      .where(
        and(
          eq(r.name, ADMIN_ROLE),
          eq(u.is_active, true),
          isNull(u.deleted_at),
          sql`${ur.user_id} <> ${userId}`,
        ),
      );
    if ((row?.n ?? 0) === 0) {
      throw new UserAccessChangeError(
        'This is the last active administrator; give someone else the admin role first',
      );
    }
  }
}
