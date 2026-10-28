import { and, desc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  createEmployerSchema,
  listEmployersForConsoleSchema,
  listEmployersSchema,
  transitionEmployerSchema,
  updateEmployerSchema,
  type CreateEmployerInput,
  type ListEmployersForConsoleInput,
  type ListEmployersInput,
  type TransitionEmployerInput,
  type UpdateEmployerInput,
} from './dto';
import { EmployerNotFoundError } from './errors';
import { nextEmployerStatus, type EmployerEvent, type EmployerStatus } from './state-machine';

const e = schema.employers;

export type Employer = typeof schema.employers.$inferSelect;

/** An employer in the console, with how many of its staff we know and have checked. */
export interface EmployerConsoleRow extends Employer {
  /** Links to customers who hold a job there now. */
  active_links: number;
  /** Of those, how many have been verified. */
  verified_links: number;
  /** Of those, how many have payroll-deduction consent. */
  consented_links: number;
}

export type EmployerCounts = Record<'pending' | 'active' | 'paused' | 'terminated' | 'all', number>;

export interface EmployerActor {
  actorId: string;
  actorType: AuditActorType;
}

export class EmployersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(rawInput: unknown, actor: EmployerActor): Promise<Employer> {
    const input: CreateEmployerInput = createEmployerSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const [row] = await tx
        .insert(e)
        .values({
          name: input.name,
          sector: input.sector,
          payroll_cycle: input.payroll_cycle,
          partnership_start_date: input.partnership_start_date,
          contact_email: input.contact_email,
          contact_phone: input.contact_phone,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) throw new Error('employer insert returned no row');

      await this.audit.append(tx, {
        entityType: 'employer',
        entityId: row.id,
        eventType: 'employer.created',
        toState: row.status,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { name: row.name },
      });
      return row;
    });
  }

  async list(rawInput: unknown = {}): Promise<Employer[]> {
    const input: ListEmployersInput = listEmployersSchema.parse(rawInput);
    const query = this.db.select().from(e);
    const filtered = input.status ? query.where(eq(e.status, input.status)) : query;
    return filtered.orderBy(desc(e.created_at)).limit(input.limit).offset(input.offset);
  }

  async listForConsole(
    rawInput: ListEmployersForConsoleInput = {},
  ): Promise<{ rows: EmployerConsoleRow[]; total: number }> {
    const input = listEmployersForConsoleSchema.parse(rawInput);
    const where: SQL[] = [];
    if (input.status) where.push(eq(e.status, input.status));
    if (input.q) {
      where.push(ilike(e.name, `%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
    }
    const filter = where.length ? and(...where) : undefined;

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(e)
      .where(filter);

    // Qualified by hand: with no join in the outer query, drizzle drops table
    // names from columns, and a bare "id" would bind to the inner table.
    const live = sql.raw(
      `FROM customer_employment l WHERE l.employer_id = employers.id AND l.status = 'active'`,
    );
    const rows = await this.db
      .select({
        employer: e,
        active_links: sql<number>`(SELECT count(*)::int ${live})`,
        verified_links: sql<number>`(SELECT count(*)::int ${live} AND l.verified_at IS NOT NULL)`,
        consented_links: sql<number>`(
          SELECT count(*)::int ${live} AND l.payroll_deduction_consent)`,
      })
      .from(e)
      .where(filter)
      .orderBy(e.name, e.id)
      .limit(input.limit)
      .offset(input.offset);

    return {
      rows: rows.map((r) => ({
        ...r.employer,
        active_links: r.active_links,
        verified_links: r.verified_links,
        consented_links: r.consented_links,
      })),
      total,
    };
  }

  async counts(): Promise<EmployerCounts> {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${e.status} = 'pending')::int`,
        active: sql<number>`count(*) FILTER (WHERE ${e.status} = 'active')::int`,
        paused: sql<number>`count(*) FILTER (WHERE ${e.status} = 'paused')::int`,
        terminated: sql<number>`count(*) FILTER (WHERE ${e.status} = 'terminated')::int`,
        all: sql<number>`count(*)::int`,
      })
      .from(e);
    return row ?? { pending: 0, active: 0, paused: 0, terminated: 0, all: 0 };
  }

  async get(id: string): Promise<Employer> {
    const rows = await this.db.select().from(e).where(eq(e.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new EmployerNotFoundError(id);
    return row;
  }

  async update(id: string, rawPatch: unknown, actor: EmployerActor): Promise<Employer> {
    const patch: UpdateEmployerInput = updateEmployerSchema.parse(rawPatch);
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(e)
        .set({ ...patch })
        .where(eq(e.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new EmployerNotFoundError(id);
      await this.audit.append(tx, {
        entityType: 'employer',
        entityId: id,
        eventType: 'employer.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });
      return row;
    });
  }

  async transition(id: string, rawInput: unknown, actor: EmployerActor): Promise<Employer> {
    const { event, reason }: TransitionEmployerInput = transitionEmployerSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      const from = current.status as EmployerStatus;
      const to = nextEmployerStatus(from, event as EmployerEvent);

      const patch: Partial<typeof e.$inferInsert> = { status: to };
      // First activation stamps partnership_start_date if not already set.
      if (to === 'active' && from === 'pending' && !current.partnership_start_date) {
        patch.partnership_start_date = new Date().toISOString().slice(0, 10);
      }

      const rows = await tx
        .update(e)
        .set(patch)
        .where(and(eq(e.id, id), eq(e.status, from)))
        .returning();
      const row = rows[0];
      if (!row) throw new EmployerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'employer',
        entityId: id,
        eventType: `employer.${event}`,
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
      });
      return row;
    });
  }

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Employer> {
    const rows = await tx.select().from(e).where(eq(e.id, id)).for('update').limit(1);
    const row = rows[0];
    if (!row) throw new EmployerNotFoundError(id);
    return row;
  }
}
