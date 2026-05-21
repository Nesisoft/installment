import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction, type TransactionalTx } from '../../shared/event-bus/transaction';
import { PasswordService } from '../../shared/auth/password.service';
import {
  createCustomerUserSchema,
  createMerchantUserSchema,
  createStaffSchema,
  type CreateCustomerUserInput,
  type CreateMerchantUserInput,
  type CreateStaffInput,
} from './dto';
import { RoleNotFoundError, UserConflictError, UserNotFoundError } from './errors';

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
    return this.insertUser(
      {
        email: input.email,
        name: input.name,
        password_hash: passwordHash,
        user_type: 'merchant',
        metadata: input.metadata ?? {},
      },
      input.roleNames ?? ['merchant_owner'],
      actor,
    );
  }

  async createCustomerUser(rawInput: unknown, actor: UserActor): Promise<User> {
    const input: CreateCustomerUserInput = createCustomerUserSchema.parse(rawInput);
    return this.insertUser(
      {
        // Customers authenticate by phone+OTP, so a synthetic unique email keeps
        // the NOT NULL/UNIQUE email column satisfied without a real inbox.
        email: input.email ?? `${input.phone}@customer.installment.local`,
        name: input.name,
        phone: input.phone,
        user_type: 'customer',
        metadata: input.metadata ?? {},
      },
      input.roleNames ?? ['customer'],
      actor,
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
  async getPermissions(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ name: perm.name })
      .from(ur)
      .innerJoin(rp, eq(rp.role_id, ur.role_id))
      .innerJoin(perm, eq(perm.id, rp.permission_id))
      .where(eq(ur.user_id, userId));
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
    for (const roleName of roleNames) {
      const found = await tx.select({ id: r.id }).from(r).where(eq(r.name, roleName)).limit(1);
      const role = found[0];
      if (!role) throw new RoleNotFoundError(roleName);
      await tx
        .insert(ur)
        .values({ user_id: userId, role_id: role.id, granted_by: uuidOrNull(actor.actorId) })
        .onConflictDoNothing();
    }
  }
}
