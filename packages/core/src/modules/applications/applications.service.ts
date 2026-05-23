import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  listApplicationsSchema,
  recordDecisionSchema,
  submitApplicationSchema,
  type ListApplicationsInput,
  type RecordDecisionInput,
  type SubmitApplicationInput,
} from './dto';
import { ApplicationNotFoundError, DuplicateApplicationError } from './errors';
import {
  nextApplicationStatus,
  type ApplicationEvent,
  type ApplicationStatus,
} from './state-machine';

const a = schema.applications;

export type Application = typeof schema.applications.$inferSelect;

export interface ApplicationActor {
  actorId: string;
  actorType: AuditActorType;
}

const NON_TERMINAL: ApplicationStatus[] = ['pending', 'counter_offered', 'manual_review'];

/** Maps a scoring DecisionOutcome to the application event that records it. */
const OUTCOME_EVENT: Record<RecordDecisionInput['outcome'], ApplicationEvent> = {
  approved: 'approve',
  approved_tier_2: 'approve',
  counter_offer: 'counter_offer',
  manual_review: 'refer_manual',
  declined: 'decline',
};

export class ApplicationsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async submit(rawInput: unknown, actor: ApplicationActor): Promise<Application> {
    const input: SubmitApplicationInput = submitApplicationSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      let row: Application;
      try {
        const inserted = await tx
          .insert(a)
          .values({
            customer_id: input.customer_id,
            merchant_id: input.merchant_id,
            plan_template_id: input.plan_template_id,
            order_reference: input.order_reference,
            order_amount_pesewas: input.order_amount_pesewas,
            merchant_category: input.merchant_category,
            ...(input.expires_at ? { expires_at: input.expires_at } : {}),
          })
          .returning();
        row = inserted[0]!;
      } catch (err) {
        if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
          throw new DuplicateApplicationError(input.merchant_id, input.order_reference);
        }
        throw err;
      }

      await this.audit.append(tx, {
        entityType: 'application',
        entityId: row.id,
        eventType: 'application.submitted',
        toState: row.status,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { merchant_id: row.merchant_id, order_reference: row.order_reference },
      });
      return row;
    });
  }

  async get(id: string): Promise<Application> {
    const rows = await this.db.select().from(a).where(eq(a.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(id);
    return row;
  }

  async list(rawInput: unknown = {}): Promise<Application[]> {
    const input: ListApplicationsInput = listApplicationsSchema.parse(rawInput);
    const where = [];
    if (input.customer_id) where.push(eq(a.customer_id, input.customer_id));
    if (input.merchant_id) where.push(eq(a.merchant_id, input.merchant_id));
    if (input.status) where.push(eq(a.status, input.status));
    const query = this.db.select().from(a);
    const filtered = where.length ? query.where(and(...where)) : query;
    return filtered.orderBy(desc(a.created_at)).limit(input.limit).offset(input.offset);
  }

  /** Apply a scoring decision to a pending / manual_review application. */
  async recordDecision(
    id: string,
    rawInput: unknown,
    actor: ApplicationActor,
  ): Promise<Application> {
    const input: RecordDecisionInput = recordDecisionSchema.parse(rawInput);
    const event = OUTCOME_EVENT[input.outcome];

    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      const from = current.status as ApplicationStatus;
      const to = nextApplicationStatus(from, event);
      const nowIso = new Date().toISOString();

      const patch: Partial<typeof a.$inferInsert> = { status: to, decision_at: nowIso };
      if (input.outcome === 'declined') patch.declined_reason = input.declined_reason ?? null;
      if (input.outcome === 'counter_offer') {
        patch.counter_down_payment_pesewas = input.counter_down_payment_pesewas;
        patch.counter_financed_pesewas = input.counter_financed_pesewas;
      }

      const rows = await tx
        .update(a)
        .set(patch)
        .where(and(eq(a.id, id), eq(a.status, from)))
        .returning();
      const row = rows[0];
      if (!row) throw new ApplicationNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'application',
        entityId: id,
        eventType: `application.${event}`,
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: input.declined_reason,
        metadata: { outcome: input.outcome },
      });
      return row;
    });
  }

  async acceptCounterOffer(id: string, actor: ApplicationActor): Promise<Application> {
    return this.applyEvent(id, 'accept_counter', actor, { decision_at: new Date().toISOString() });
  }

  async cancel(id: string, actor: ApplicationActor): Promise<Application> {
    return this.applyEvent(id, 'cancel', actor);
  }

  /**
   * Marks every non-terminal application past its expires_at as expired.
   * Returns the number expired. Atomic: the bulk update and its audit rows
   * commit together.
   */
  async expireOverdue(now: Date = new Date(), actor?: ApplicationActor): Promise<number> {
    const nowIso = now.toISOString();
    const who = actor ?? {
      actorId: '00000000-0000-0000-0000-000000000002',
      actorType: 'worker' as const,
    };

    return runInTransaction(this.db, async (tx) => {
      const expired = await tx
        .update(a)
        .set({ status: 'expired' })
        .where(and(inArray(a.status, NON_TERMINAL), lte(a.expires_at, nowIso)))
        .returning({ id: a.id, from: a.status });

      for (const row of expired) {
        await this.audit.append(tx, {
          entityType: 'application',
          entityId: row.id,
          eventType: 'application.expire',
          toState: 'expired',
          actorId: who.actorId,
          actorType: who.actorType,
        });
      }
      return expired.length;
    });
  }

  // ----------------------------------------------------------- internals

  private async applyEvent(
    id: string,
    event: ApplicationEvent,
    actor: ApplicationActor,
    extraPatch: Partial<typeof a.$inferInsert> = {},
  ): Promise<Application> {
    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      const from = current.status as ApplicationStatus;
      const to = nextApplicationStatus(from, event);

      const rows = await tx
        .update(a)
        .set({ status: to, ...extraPatch })
        .where(and(eq(a.id, id), eq(a.status, from)))
        .returning();
      const row = rows[0];
      if (!row) throw new ApplicationNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'application',
        entityId: id,
        eventType: `application.${event}`,
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return row;
    });
  }

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Application> {
    const rows = await tx.select().from(a).where(eq(a.id, id)).for('update').limit(1);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(id);
    return row;
  }
}
