import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  linkEmploymentSchema,
  listEmploymentForConsoleSchema,
  listEmploymentSchema,
  recordPayrollConsentSchema,
  transitionEmploymentSchema,
  unverifyEmploymentSchema,
  updateEmploymentSchema,
  verifyEmploymentSchema,
  type LinkEmploymentInput,
  type ListEmploymentForConsoleInput,
  type ListEmploymentInput,
  type RecordPayrollConsentInput,
  type TransitionEmploymentInput,
  type UpdateEmploymentInput,
} from './dto';
import {
  DuplicateEmploymentError,
  EmployerNotFoundError,
  EmploymentNotAllowedError,
  EmploymentNotFoundError,
} from './errors';
import { CustomerNotFoundError } from '../customers/errors';
import { nextEmploymentStatus, type EmploymentEvent, type EmploymentStatus } from './state-machine';

const ce = schema.customer_employment;
const emp = schema.employers;
const cust = schema.customers;

export type Employment = typeof schema.customer_employment.$inferSelect;

/** One link in the console: the job, and whose job at which employer. */
export interface EmploymentConsoleRow extends Employment {
  customer_name: string | null;
  customer_phone: string | null;
  employer_name: string;
  employer_status: string;
}

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
      // Checked here rather than left to the foreign keys, which answered an
      // unknown id with a 500.
      const [customer] = await tx
        .select({ id: cust.id })
        .from(cust)
        .where(eq(cust.id, input.customer_id))
        .limit(1);
      if (!customer) throw new CustomerNotFoundError(input.customer_id);
      const [employer] = await tx
        .select({ status: emp.status })
        .from(emp)
        .where(eq(emp.id, input.employer_id))
        .limit(1);
      if (!employer) throw new EmployerNotFoundError(input.employer_id);
      if (employer.status === 'terminated') {
        throw new EmploymentNotAllowedError(
          "That employer's partnership has ended; a new link to it would count for nothing",
        );
      }

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

      // Leaving ends the job that was verified and the payroll the mandate
      // deducted from. If the customer is later recorded as having rejoined,
      // that is a new spell of employment: it is checked again and consent is
      // recorded again, rather than inheriting either. Consent matters on its
      // own — it doubles a scored customer's limit.
      const leaving = event === 'leave_employer';
      const rows = await tx
        .update(ce)
        .set(
          leaving
            ? {
                status: to,
                verified_at: null,
                payroll_deduction_consent: false,
                consent_signed_at: null,
              }
            : { status: to },
        )
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
        ...(leaving && (current.verified_at || current.payroll_deduction_consent)
          ? {
              metadata: {
                verification_cleared: current.verified_at !== null,
                consent_cleared: current.payroll_deduction_consent,
              },
            }
          : {}),
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
      const current = await this.loadWithLock(tx, id);
      // A mandate to deduct from a salary the customer no longer draws.
      // Withdrawing one is always allowed.
      if (input.granted && current.status !== 'active') {
        throw new EmploymentNotAllowedError(
          `Payroll consent needs a job the customer holds; this link is ${current.status}`,
        );
      }
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
        ...(input.note ? { reason: input.note } : {}),
      });
      return row;
    });
  }

  /**
   * Confirm the customer holds this job.
   *
   * It is what moves a first-time customer from the base starter limit to the
   * employer tier, so it records how the job was confirmed and what was
   * checked, and it refuses a link the customer no longer holds or one to an
   * employer whose partnership has ended — the scorer would ignore those
   * anyway, and a verification nobody can use reads as one that counts.
   */
  async markVerified(id: string, rawInput: unknown, actor: EmploymentActor): Promise<Employment> {
    const input = verifyEmploymentSchema.parse(rawInput);
    const nowIso = new Date().toISOString();
    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      if (current.status !== 'active') {
        throw new EmploymentNotAllowedError(
          `Only a job the customer holds can be verified; this link is ${current.status}`,
        );
      }
      const [employer] = await tx
        .select({ status: emp.status })
        .from(emp)
        .where(eq(emp.id, current.employer_id))
        .limit(1);
      if (employer?.status === 'terminated') {
        throw new EmploymentNotAllowedError(
          "That employer's partnership has ended; a verification would count for nothing",
        );
      }
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
        reason: input.note,
        metadata: { method: input.method, reverified: current.verified_at !== null },
      });
      return row;
    });
  }

  /**
   * Withdraw a verification that turned out to be wrong. The customer drops
   * back to the base starter limit on their next decision.
   */
  async unverify(id: string, rawInput: unknown, actor: EmploymentActor): Promise<Employment> {
    const { reason } = unverifyEmploymentSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      if (current.verified_at === null) return current;
      const rows = await tx.update(ce).set({ verified_at: null }).where(eq(ce.id, id)).returning();
      const row = rows[0];
      if (!row) throw new EmploymentNotFoundError(id);
      await this.audit.append(tx, {
        entityType: 'customer_employment',
        entityId: id,
        eventType: 'customer_employment.unverified',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
        metadata: { was_verified_at: current.verified_at },
      });
      return row;
    });
  }

  /**
   * Links as the console shows them, with whose job at which employer. Those
   * waiting for verification come oldest first — the queue order; otherwise
   * newest first.
   */
  async listForConsole(
    rawInput: ListEmploymentForConsoleInput = {},
  ): Promise<{ rows: EmploymentConsoleRow[]; total: number }> {
    const input = listEmploymentForConsoleSchema.parse(rawInput);
    const where: SQL[] = [];
    if (input.customer_id) where.push(eq(ce.customer_id, input.customer_id));
    if (input.employer_id) where.push(eq(ce.employer_id, input.employer_id));
    if (input.status) where.push(eq(ce.status, input.status));
    if (input.verified === true) where.push(isNotNull(ce.verified_at));
    if (input.verified === false) where.push(isNull(ce.verified_at));
    const filter = where.length ? and(...where) : undefined;

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(ce)
      .where(filter);

    const queue = input.verified === false;
    const rows = await this.db
      .select({
        link: ce,
        customer_name: sql<
          string | null
        >`nullif(trim(concat_ws(' ', ${cust.first_name}, ${cust.last_name})), '')`,
        customer_phone: cust.phone,
        employer_name: emp.name,
        employer_status: emp.status,
      })
      .from(ce)
      .innerJoin(emp, eq(emp.id, ce.employer_id))
      .leftJoin(cust, eq(cust.id, ce.customer_id))
      .where(filter)
      .orderBy(queue ? asc(ce.created_at) : desc(ce.created_at), asc(ce.id))
      .limit(input.limit)
      .offset(input.offset);

    return {
      rows: rows.map((r) => ({
        ...r.link,
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        employer_name: r.employer_name,
        employer_status: r.employer_status,
      })),
      total,
    };
  }

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Employment> {
    const rows = await tx.select().from(ce).where(eq(ce.id, id)).for('update').limit(1);
    const row = rows[0];
    if (!row) throw new EmploymentNotFoundError(id);
    return row;
  }
}
