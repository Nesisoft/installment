import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  linkEmploymentSchema,
  listEmploymentSchema,
  recordPayrollConsentSchema,
  transitionEmploymentSchema,
  updateEmploymentSchema,
  type LinkEmploymentInput,
  type ListEmploymentInput,
  type RecordPayrollConsentInput,
  type TransitionEmploymentInput,
  type UpdateEmploymentInput,
} from './dto';
import { DuplicateEmploymentError, EmploymentNotFoundError } from './errors';
import { nextEmploymentStatus, type EmploymentEvent, type EmploymentStatus } from './state-machine';

const ce = schema.customer_employment;

export type Employment = typeof schema.customer_employment.$inferSelect;

export interface EmploymentActor {
  actorId: string;
  actorType: AuditActorType;
}

export class CustomerEmploymentService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async link(rawInput: unknown, actor: EmploymentActor): Promise<Employment> {
    const input: LinkEmploymentInput = linkEmploymentSchema.parse(rawInput);
    const nowIso = new Date().toISOString();

    return runInTransaction(this.db, async (tx) => {
      try {
        const [row] = await tx
          .insert(ce)
          .values({
            customer_id: input.customer_id,
            employer_id: input.employer_id,
            employee_number: input.employee_number,
            salary_band: input.salary_band,
            employment_start_date: input.employment_start_date,
            payroll_deduction_consent: input.payroll_deduction_consent,
            consent_signed_at: input.payroll_deduction_consent ? nowIso : null,
          })
          .returning();
        if (!row) throw new Error('customer_employment insert returned no row');

        await this.audit.append(tx, {
          entityType: 'customer_employment',
          entityId: row.id,
          eventType: 'customer_employment.linked',
          toState: row.status,
          actorId: actor.actorId,
          actorType: actor.actorType,
          metadata: {
            customer_id: input.customer_id,
            employer_id: input.employer_id,
            consented: input.payroll_deduction_consent,
          },
        });
        return row;
      } catch (err) {
        // Map the (customer_id, employer_id) UNIQUE violation to a typed error.
        const pgCode = (err as { cause?: { code?: string } }).cause?.code;
        if (pgCode === '23505') {
          throw new DuplicateEmploymentError(input.customer_id, input.employer_id);
        }
        throw err;
      }
    });
  }

  async list(rawInput: unknown = {}): Promise<Employment[]> {
    const input: ListEmploymentInput = listEmploymentSchema.parse(rawInput);
    const where = [];
    if (input.customer_id) where.push(eq(ce.customer_id, input.customer_id));
    if (input.employer_id) where.push(eq(ce.employer_id, input.employer_id));
    if (input.status) where.push(eq(ce.status, input.status));

    const query = this.db.select().from(ce);
    const filtered = where.length ? query.where(and(...where)) : query;
    return filtered.orderBy(desc(ce.created_at)).limit(input.limit).offset(input.offset);
  }

  async get(id: string): Promise<Employment> {
    const rows = await this.db.select().from(ce).where(eq(ce.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new EmploymentNotFoundError(id);
    return row;
  }

  async update(id: string, rawPatch: unknown, actor: EmploymentActor): Promise<Employment> {
    const patch: UpdateEmploymentInput = updateEmploymentSchema.parse(rawPatch);
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(ce)
        .set({ ...patch })
        .where(eq(ce.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new EmploymentNotFoundError(id);
      await this.audit.append(tx, {
        entityType: 'customer_employment',
        entityId: id,
        eventType: 'customer_employment.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });
      return row;
    });
  }

  async transition(id: string, rawInput: unknown, actor: EmploymentActor): Promise<Employment> {
    const { event, reason }: TransitionEmploymentInput = transitionEmploymentSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      const from = current.status as EmploymentStatus;
      const to = nextEmploymentStatus(from, event as EmploymentEvent);

      const rows = await tx
        .update(ce)
        .set({ status: to })
        .where(and(eq(ce.id, id), eq(ce.status, from)))
        .returning();
      const row = rows[0];
      if (!row) throw new EmploymentNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer_employment',
        entityId: id,
        eventType: `customer_employment.${event}`,
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
      });
      return row;
    });
  }

  async recordPayrollConsent(
    id: string,
    rawInput: unknown,
    actor: EmploymentActor,
  ): Promise<Employment> {
    const input: RecordPayrollConsentInput = recordPayrollConsentSchema.parse(rawInput);
    const nowIso = new Date().toISOString();

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(ce)
        .set({
          payroll_deduction_consent: input.granted,
          consent_signed_at: input.granted ? nowIso : null,
        })
        .where(eq(ce.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new EmploymentNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer_employment',
        entityId: id,
        eventType: input.granted
          ? 'customer_employment.consent_granted'
          : 'customer_employment.consent_revoked',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return row;
    });
  }

  async markVerified(id: string, actor: EmploymentActor): Promise<Employment> {
    const nowIso = new Date().toISOString();
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(ce)
        .set({ verified_at: nowIso })
        .where(eq(ce.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new EmploymentNotFoundError(id);
      await this.audit.append(tx, {
        entityType: 'customer_employment',
        entityId: id,
        eventType: 'customer_employment.verified',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return row;
    });
  }

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Employment> {
    const rows = await tx.select().from(ce).where(eq(ce.id, id)).for('update').limit(1);
    const row = rows[0];
    if (!row) throw new EmploymentNotFoundError(id);
    return row;
  }
}
