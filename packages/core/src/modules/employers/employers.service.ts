import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  createEmployerSchema,
  listEmployersSchema,
  transitionEmployerSchema,
  updateEmployerSchema,
  type CreateEmployerInput,
  type ListEmployersInput,
  type TransitionEmployerInput,
  type UpdateEmployerInput,
} from './dto';
import { EmployerNotFoundError } from './errors';
import { nextEmployerStatus, type EmployerEvent, type EmployerStatus } from './state-machine';

const e = schema.employers;

export type Employer = typeof schema.employers.$inferSelect;

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
