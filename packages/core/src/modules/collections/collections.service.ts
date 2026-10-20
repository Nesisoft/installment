import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  nextScheduleStatus,
  type ScheduleEvent,
  type ScheduleStatus,
} from '../schedules/state-machine';
import { PlanDefaultError } from '../schedules/errors';
import { assignCaseSchema, closeCaseSchema, listCasesSchema, recordActionSchema } from './dto';
import {
  CaseAlreadyClosedError,
  CaseNotSettledError,
  CollectionsCaseNotFoundError,
} from './errors';
import {
  COLLECTIONS_STAGES,
  isLaterStage,
  stageForAge,
  type CollectionsStage,
} from './stage-policy';

const sched = schema.installment_schedule;
const cases = schema.collections_cases;
const actions = schema.collections_actions;
const plansTable = schema.customer_plans;
const customersTable = schema.customers;

const DAY_MS = 86_400_000;

/**
 * The event that escalates each sweepable state to `overdue`. A state absent
 * from this map is not escalatable — either it is already past `overdue`, or
 * it is terminal, or the row raced into it after being selected.
 */
const GRACE_ESCALATION_EVENT: Partial<Record<ScheduleStatus, ScheduleEvent>> = {
  due: 'unprocessed_past_grace',
  pending: 'unprocessed_past_grace',
  failed: 'grace_expired',
  retry_scheduled: 'grace_expired',
};

export type CollectionsCase = typeof schema.collections_cases.$inferSelect;
export type CollectionsAction = typeof schema.collections_actions.$inferSelect;

/** A case plus the context an agent needs to work it. */
export interface CollectionsCaseDetail {
  case: CollectionsCase;
  actions: CollectionsAction[];
  plan: typeof schema.customer_plans.$inferSelect | null;
  schedule: typeof schema.installment_schedule.$inferSelect | null;
  customer: { id: string; first_name: string; last_name: string; phone: string } | null;
}

export interface CollectionsActor {
  actorId: string;
  actorType: AuditActorType;
}

/**
 * What CollectionsService needs to default a plan once a case writes off —
 * satisfied by CustomerPlansService.markPlanDefaulted. Optional so collections
 * works without the settlement side wired (tests, framework-free callers).
 */
export interface PlanDefaulter {
  markPlanDefaulted(
    planId: string,
    opts: { reason?: string },
    actor: CollectionsActor,
  ): Promise<unknown>;
}

/** Optional port: fires a customer-facing SMS when a case enters a new stage. */
export interface StageNotifier {
  notifyStageEntered(args: {
    customerPlanId: string;
    scheduleId: string | null;
    stage: CollectionsStage;
  }): Promise<void>;
}

export interface CollectionsSweepSummary {
  /** Cases closed because their instalment is no longer owed. */
  settledClosed: number;
  graceExpired: number;
  casesOpened: number;
  stagesAdvanced: number;
  writtenOff: number;
  advances: Array<{ caseId: string; from: CollectionsStage; to: CollectionsStage }>;
}

/**
 * How a case is resolved once its instalment has left `in_collections`.
 * Anything absent here is still owed, so the case stays open and keeps
 * escalating. `defaulted` is listed so a case left open beside an
 * already-defaulted row is tidied rather than re-defaulting the plan.
 */
const SETTLED_RESOLUTION: Partial<Record<ScheduleStatus, string>> = {
  paid: 'paid',
  waived: 'waived',
  refunded: 'waived',
  restructured: 'restructured',
  defaulted: 'defaulted',
};

/**
 * Owns the collections lifecycle. Three operations, each idempotent and run as
 * a daily sweep:
 *
 *   1. grace-expiry  — due/failed installments past their grace date → overdue
 *   2. case-opening  — overdue installments (no open case) → a collections case
 *                      + the schedule moves overdue → in_collections
 *   3. stage advance — open cases escalate through the dunning stages by age
 *
 * Transitions are applied inline (SELECT FOR UPDATE + version guard + audit, in
 * one transaction) the same way CustomerPlansService does, so a case and its
 * schedule transition can never diverge.
 */
export class CollectionsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    /** Books the plan default when a case reaches write_off. */
    private readonly planDefaulter?: PlanDefaulter,
    /** Texts the customer when a case enters a customer-facing stage. */
    private readonly stageNotifier?: StageNotifier,
  ) {}

  /** Fire-and-forget stage SMS: never throws, never blocks the transition. */
  private notifyStage(
    customerPlanId: string,
    scheduleId: string | null,
    stage: CollectionsStage,
  ): void {
    if (!this.stageNotifier) return;
    void this.stageNotifier.notifyStageEntered({ customerPlanId, scheduleId, stage }).catch(() => {
      // best-effort
    });
  }

  /**
   * Moves any non-terminal, unpaid installment past its grace date to
   * `overdue`.
   *
   * `retry_scheduled` and `pending` are included deliberately. The retry queue
   * is the only owner of `retry_scheduled`, so a lost BullMQ job, an evicted
   * Redis key, or simply reaching the payment-link step and never being paid
   * left the row there permanently — no case, no dunning, no write-off, no
   * default. `pending` covers a plan activated for a customer who never had a
   * chargeable instrument. Both were invisible to every sweep in the system,
   * which means delinquency reporting systematically under-reported bad debt.
   */
  async escalateGraceExpired(
    asOf: Date,
    actor: CollectionsActor,
    opts: { limit?: number } = {},
  ): Promise<number> {
    const asOfDate = asOf.toISOString().slice(0, 10);
    const candidates = await this.db
      .select({ id: sched.id, status: sched.status })
      .from(sched)
      .where(
        and(
          inArray(sched.status, ['due', 'failed', 'retry_scheduled', 'pending']),
          lt(sched.grace_until_date, asOfDate),
        ),
      )
      .limit(opts.limit ?? 1_000);

    let count = 0;
    for (const row of candidates) {
      if (await this.escalateOne(row.id, actor, asOf)) count += 1;
    }
    return count;
  }

  private async escalateOne(
    scheduleId: string,
    actor: CollectionsActor,
    asOf: Date,
  ): Promise<boolean> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
      )[0];
      if (!row) return false;
      const from = row.status as ScheduleStatus;
      const event = GRACE_ESCALATION_EVENT[from];
      if (!event) return false; // raced into another state; skip
      nextScheduleStatus(from, event); // validates → overdue

      const updated = await tx
        .update(sched)
        .set({
          status: 'overdue',
          status_changed_at: asOf.toISOString(),
          version: row.version + 1,
        })
        .where(and(eq(sched.id, scheduleId), eq(sched.version, row.version)))
        .returning();
      if (!updated[0]) return false;

      await this.audit.append(tx, {
        entityType: 'installment_schedule',
        entityId: scheduleId,
        eventType: `schedule.${event}`,
        fromState: from,
        toState: 'overdue',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return true;
    });
  }

  /** Opens a collections case for every overdue installment without one. */
  async openCasesForOverdue(actor: CollectionsActor, now: Date = new Date()): Promise<number> {
    const overdue = await this.db
      .select({ id: sched.id })
      .from(sched)
      .where(eq(sched.status, 'overdue'));
    if (overdue.length === 0) return 0;

    const open = await this.db
      .select({ scheduleId: cases.schedule_id })
      .from(cases)
      .where(isNull(cases.closed_at));
    const withCase = new Set(open.map((c) => c.scheduleId));

    let opened = 0;
    for (const row of overdue) {
      if (withCase.has(row.id)) continue;
      if (await this.openCase(row.id, actor, now)) opened += 1;
    }
    return opened;
  }

  private async openCase(
    scheduleId: string,
    actor: CollectionsActor,
    now: Date,
  ): Promise<CollectionsCase | null> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
      )[0];
      if (!row || (row.status as ScheduleStatus) !== 'overdue') return null;

      // Guard against a concurrent open (another worker) inside the tx.
      const existing = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.schedule_id, scheduleId), isNull(cases.closed_at)))
        .limit(1);
      if (existing[0]) return null;

      nextScheduleStatus('overdue', 'case_opened'); // → in_collections

      const updated = await tx
        .update(sched)
        .set({
          status: 'in_collections',
          status_changed_at: now.toISOString(),
          version: row.version + 1,
        })
        .where(and(eq(sched.id, scheduleId), eq(sched.version, row.version)))
        .returning();
      if (!updated[0]) return null;

      const [openedCase] = await tx
        .insert(cases)
        .values({
          customer_plan_id: row.customer_plan_id,
          schedule_id: scheduleId,
          current_stage: 'soft_reminder',
          opened_at: now.toISOString(),
          stage_entered_at: now.toISOString(),
        })
        .returning();
      if (!openedCase) throw new Error('collections_cases insert returned no row');

      await this.audit.append(tx, {
        entityType: 'installment_schedule',
        entityId: scheduleId,
        eventType: 'schedule.case_opened',
        fromState: 'overdue',
        toState: 'in_collections',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { case_id: openedCase.id },
      });
      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: openedCase.id,
        eventType: 'collections_case.opened',
        toState: 'soft_reminder',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { schedule_id: scheduleId, customer_plan_id: row.customer_plan_id },
      });
      this.notifyStage(row.customer_plan_id, scheduleId, 'soft_reminder');
      return openedCase;
    });
  }

  /** Escalates every open case to the stage its age warrants. */
  async advanceStages(
    asOf: Date,
    actor: CollectionsActor,
  ): Promise<Array<{ caseId: string; from: CollectionsStage; to: CollectionsStage }>> {
    const open = await this.db.select().from(cases).where(isNull(cases.closed_at));
    const advances: Array<{ caseId: string; from: CollectionsStage; to: CollectionsStage }> = [];

    for (const c of open) {
      const ageDays = Math.floor((asOf.getTime() - new Date(c.opened_at).getTime()) / DAY_MS);
      const current = c.current_stage as CollectionsStage;
      const target = stageForAge(ageDays);
      if (!isLaterStage(target, current)) continue;

      const moved = await this.advanceOne(c.id, current, target, actor, asOf);
      if (moved) advances.push({ caseId: c.id, from: current, to: target });
    }
    return advances;
  }

  private async advanceOne(
    caseId: string,
    from: CollectionsStage,
    to: CollectionsStage,
    actor: CollectionsActor,
    asOf: Date,
  ): Promise<boolean> {
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1)
      )[0];
      // Re-check under lock — another worker may have advanced it already.
      if (!row || row.closed_at || (row.current_stage as CollectionsStage) !== from) return false;

      await tx
        .update(cases)
        .set({ current_stage: to, stage_entered_at: asOf.toISOString() })
        .where(eq(cases.id, caseId));

      await tx.insert(actions).values({
        case_id: caseId,
        action_type: 'stage_changed',
        outcome: to,
        performed_by: actor.actorId,
        metadata: { from, to },
      });

      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: caseId,
        eventType: 'collections_case.stage_changed',
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      this.notifyStage(row.customer_plan_id, row.schedule_id, to);
      return true;
    });
  }

  /**
   * Resolves cases that have reached `write_off`: defaults the plan (booking the
   * loss for its full outstanding) and closes the case as `defaulted`, moving
   * its installment in_collections → defaulted. Idempotent — re-running skips
   * already-closed cases, and the plan default is no-op'd if a sibling case
   * already triggered it.
   */
  async defaultWrittenOffCases(actor: CollectionsActor, now: Date = new Date()): Promise<number> {
    const writeOffs = await this.db
      .select()
      .from(cases)
      .where(and(eq(cases.current_stage, 'write_off'), isNull(cases.closed_at)));

    let resolved = 0;
    for (const c of writeOffs) {
      if (await this.resolveWriteOff(c, actor, now)) resolved += 1;
    }
    return resolved;
  }

  private async resolveWriteOff(
    c: CollectionsCase,
    actor: CollectionsActor,
    now: Date,
  ): Promise<boolean> {
    // 0. Never default a debt that is no longer owed. The ordering below put
    //    `markPlanDefaulted` first, before anything read the instalment — so a
    //    case left open over a paid row defaulted the plan of a customer who
    //    had paid, writing off the receivable, consuming the merchant's
    //    reserve and clawing back the rest. `closeSettledCases` should have
    //    closed such a case already; this is the guard that makes the money
    //    move impossible rather than merely unlikely.
    if (c.schedule_id) {
      const s = (await this.db.select().from(sched).where(eq(sched.id, c.schedule_id)).limit(1))[0];
      if (s && (s.status as ScheduleStatus) !== 'in_collections') {
        const resolution = SETTLED_RESOLUTION[s.status as ScheduleStatus];
        if (resolution) {
          await this.db
            .update(cases)
            .set({ resolution, closed_at: now.toISOString() })
            .where(and(eq(cases.id, c.id), isNull(cases.closed_at)));
          await this.audit.append(this.db, {
            entityType: 'collections_case',
            entityId: c.id,
            eventType: 'collections_case.closed',
            fromState: 'write_off',
            toState: resolution,
            reason: `instalment ${s.status} — not defaulted`,
            actorId: actor.actorId,
            actorType: actor.actorType,
          });
        }
        return false;
      }
    }

    // 1. Default the plan first (full-outstanding loss). A sibling case may have
    //    already defaulted it → PlanDefaultError, which is a safe no-op here.
    if (this.planDefaulter) {
      try {
        await this.planDefaulter.markPlanDefaulted(
          c.customer_plan_id,
          { reason: 'collections_write_off' },
          actor,
        );
      } catch (err) {
        if (!(err instanceof PlanDefaultError)) throw err;
      }
    }

    // 2. Close the case + move its installment to defaulted, atomically.
    return runInTransaction(this.db, async (tx) => {
      const row = (
        await tx.select().from(cases).where(eq(cases.id, c.id)).for('update').limit(1)
      )[0];
      if (!row || row.closed_at) return false;

      if (row.schedule_id) {
        const s = (
          await tx.select().from(sched).where(eq(sched.id, row.schedule_id)).for('update').limit(1)
        )[0];
        if (s && (s.status as ScheduleStatus) === 'in_collections') {
          nextScheduleStatus('in_collections', 'default_threshold_hit'); // → defaulted
          await tx
            .update(sched)
            .set({
              status: 'defaulted',
              status_changed_at: now.toISOString(),
              version: s.version + 1,
            })
            .where(and(eq(sched.id, s.id), eq(sched.version, s.version)));
          await this.audit.append(tx, {
            entityType: 'installment_schedule',
            entityId: s.id,
            eventType: 'schedule.default_threshold_hit',
            fromState: 'in_collections',
            toState: 'defaulted',
            actorId: actor.actorId,
            actorType: actor.actorType,
          });
        }
      }

      await tx
        .update(cases)
        .set({ resolution: 'defaulted', closed_at: now.toISOString() })
        .where(eq(cases.id, c.id));
      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: c.id,
        eventType: 'collections_case.closed',
        fromState: 'write_off',
        toState: 'defaulted',
        reason: 'write_off',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return true;
    });
  }

  /** Runs the full daily collections sweep in order. */
  async runSweep(
    actor: CollectionsActor,
    asOf: Date = new Date(),
  ): Promise<CollectionsSweepSummary> {
    // Settled debts first. A case whose instalment has left `in_collections`
    // must be closed before anything else looks at it: `advanceStages` filters
    // on `closed_at` alone and never reads the instalment, so an open case over
    // a paid row keeps escalating and keeps texting a customer who has paid.
    const settledClosed = await this.closeSettledCases(actor, asOf);
    const graceExpired = await this.escalateGraceExpired(asOf, actor);
    const casesOpened = await this.openCasesForOverdue(actor, asOf);
    const advances = await this.advanceStages(asOf, actor);
    const writtenOff = await this.defaultWrittenOffCases(actor, asOf);
    return {
      settledClosed,
      graceExpired,
      casesOpened,
      stagesAdvanced: advances.length,
      writtenOff,
      advances,
    };
  }

  /**
   * Closes every open case whose instalment is no longer in collections.
   *
   * Nothing else does this. `closed_at` is written in exactly two places — the
   * write-off path and the manual `closeCase` — and a payment reaches neither.
   * Paying moved the schedule to `paid` and left the case open, so the customer
   * went on receiving dunning SMS and, at ninety days, `resolveWriteOff`
   * defaulted their plan.
   *
   * Run as part of the sweep rather than called from the payment path on
   * purpose: `CollectionsService` already depends on `CustomerPlansService`,
   * so a call the other way would close the loop, and a sweep heals cases that
   * are already stranded rather than only new ones.
   */
  async closeSettledCases(actor: CollectionsActor, asOf: Date = new Date()): Promise<number> {
    const open = await this.db
      .select({ id: cases.id, scheduleId: cases.schedule_id, stage: cases.current_stage })
      .from(cases)
      .where(isNull(cases.closed_at));
    if (open.length === 0) return 0;

    let closed = 0;
    for (const c of open) {
      if (!c.scheduleId) continue;
      const s = (await this.db.select().from(sched).where(eq(sched.id, c.scheduleId)).limit(1))[0];
      if (!s) continue;
      const resolution = SETTLED_RESOLUTION[s.status as ScheduleStatus];
      if (!resolution) continue; // still owed — leave the case to the dunning stages

      const [updated] = await this.db
        .update(cases)
        .set({ resolution, closed_at: asOf.toISOString() })
        .where(and(eq(cases.id, c.id), isNull(cases.closed_at)))
        .returning();
      if (!updated) continue;

      await this.audit.append(this.db, {
        entityType: 'collections_case',
        entityId: c.id,
        eventType: 'collections_case.closed',
        fromState: c.stage,
        toState: resolution,
        reason: `instalment ${s.status}`,
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      closed += 1;
    }
    return closed;
  }

  // --------------------------------------------------------- agent worklist

  /** Lists collections cases for the ops queue (open by default), newest first. */
  async listCases(rawInput: unknown = {}): Promise<CollectionsCase[]> {
    const input = listCasesSchema.parse(rawInput);
    const where = [];
    if (input.stage) where.push(eq(cases.current_stage, input.stage));
    if (input.assigned_agent_id) where.push(eq(cases.assigned_agent_id, input.assigned_agent_id));
    if (input.open === true) where.push(isNull(cases.closed_at));
    else if (input.open === false) where.push(isNotNull(cases.closed_at));

    const query = this.db.select().from(cases);
    const filtered = where.length ? query.where(and(...where)) : query;
    return filtered.orderBy(desc(cases.stage_entered_at)).limit(input.limit).offset(input.offset);
  }

  /** A single case with its action timeline, plan, schedule and customer. */
  async getCase(id: string): Promise<CollectionsCaseDetail> {
    const c = (await this.db.select().from(cases).where(eq(cases.id, id)).limit(1))[0];
    if (!c) throw new CollectionsCaseNotFoundError(id);

    const actionRows = await this.db
      .select()
      .from(actions)
      .where(eq(actions.case_id, id))
      .orderBy(desc(actions.performed_at));

    const plan =
      (
        await this.db
          .select()
          .from(plansTable)
          .where(eq(plansTable.id, c.customer_plan_id))
          .limit(1)
      )[0] ?? null;

    const schedule = c.schedule_id
      ? ((await this.db.select().from(sched).where(eq(sched.id, c.schedule_id)).limit(1))[0] ??
        null)
      : null;

    let customer: CollectionsCaseDetail['customer'] = null;
    if (plan) {
      customer =
        (
          await this.db
            .select({
              id: customersTable.id,
              first_name: customersTable.first_name,
              last_name: customersTable.last_name,
              phone: customersTable.phone,
            })
            .from(customersTable)
            .where(eq(customersTable.id, plan.customer_id))
            .limit(1)
        )[0] ?? null;
    }

    return { case: c, actions: actionRows, plan, schedule, customer };
  }

  /** Records a manual agent action (call/visit/note/...) on an open case. */
  async recordAction(
    caseId: string,
    rawInput: unknown,
    actor: CollectionsActor,
  ): Promise<CollectionsAction> {
    const input = recordActionSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const c = (
        await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1)
      )[0];
      if (!c) throw new CollectionsCaseNotFoundError(caseId);
      if (c.closed_at) throw new CaseAlreadyClosedError(caseId);

      const [action] = await tx
        .insert(actions)
        .values({
          case_id: caseId,
          action_type: input.action_type,
          channel: input.channel ?? null,
          outcome: input.outcome ?? null,
          notes: input.notes ?? null,
          performed_by: actor.actorId,
        })
        .returning();
      if (!action) throw new Error('collections_actions insert returned no row');

      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: caseId,
        eventType: 'collections_case.action_recorded',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { action_type: input.action_type },
      });
      return action;
    });
  }

  /** Assigns (or reassigns) an open case to an agent. */
  async assignAgent(
    caseId: string,
    rawInput: unknown,
    actor: CollectionsActor,
  ): Promise<CollectionsCase> {
    const input = assignCaseSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const c = (
        await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1)
      )[0];
      if (!c) throw new CollectionsCaseNotFoundError(caseId);
      if (c.closed_at) throw new CaseAlreadyClosedError(caseId);

      const [updated] = await tx
        .update(cases)
        .set({ assigned_agent_id: input.agent_id })
        .where(eq(cases.id, caseId))
        .returning();
      if (!updated) throw new CollectionsCaseNotFoundError(caseId);

      await tx.insert(actions).values({
        case_id: caseId,
        action_type: 'note_added',
        outcome: 'assigned',
        notes: `Assigned to agent ${input.agent_id}`,
        performed_by: actor.actorId,
        metadata: { assigned_agent_id: input.agent_id },
      });
      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: caseId,
        eventType: 'collections_case.assigned',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { assigned_agent_id: input.agent_id },
      });
      return updated;
    });
  }

  /**
   * Manually closes an open case with a non-default resolution (paid / waived).
   *
   * `paid` records nothing — it closes early a case the payment flow has
   * already settled (`closeSettledCases` would close it on the next sweep). So
   * it is refused unless the instalment really is `paid`: a closed case is
   * never looked at again, and closing one beside an unpaid instalment — a
   * customer who says they paid in cash — forgave the debt with nothing on
   * record. The payment is recorded on the plan first.
   *
   * `waived` does: the state machine has an `in_collections:admin_waive →
   * waived` edge and nothing dispatched it, so waiving closed the case and
   * left the instalment in `in_collections` with no open case — invisible to
   * `openCasesForOverdue`, which only selects `overdue`, and so never
   * collected, waived or written off again. Applied here, the debt actually
   * ends.
   *
   * `restructured` is not accepted (see `closeCaseSchema`): restructuring
   * means issuing a replacement plan (`customer_plans.restructured_from_plan_id`)
   * and no such flow exists, so closing a case that way stranded the
   * instalment.
   */
  async closeCase(
    caseId: string,
    rawInput: unknown,
    actor: CollectionsActor,
  ): Promise<CollectionsCase> {
    const input = closeCaseSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const c = (
        await tx.select().from(cases).where(eq(cases.id, caseId)).for('update').limit(1)
      )[0];
      if (!c) throw new CollectionsCaseNotFoundError(caseId);
      if (c.closed_at) throw new CaseAlreadyClosedError(caseId);

      const nowIso = new Date().toISOString();

      if (input.resolution === 'paid' && c.schedule_id) {
        const s = (
          await tx.select().from(sched).where(eq(sched.id, c.schedule_id)).for('update').limit(1)
        )[0];
        if (s && (s.status as ScheduleStatus) !== 'paid') {
          throw new CaseNotSettledError(caseId, s.status);
        }
      }

      if (input.resolution === 'waived' && c.schedule_id) {
        const s = (
          await tx.select().from(sched).where(eq(sched.id, c.schedule_id)).for('update').limit(1)
        )[0];
        if (s && (s.status as ScheduleStatus) === 'in_collections') {
          nextScheduleStatus('in_collections', 'admin_waive'); // → waived
          await tx
            .update(sched)
            .set({ status: 'waived', status_changed_at: nowIso, version: s.version + 1 })
            .where(and(eq(sched.id, s.id), eq(sched.version, s.version)));
          await this.audit.append(tx, {
            entityType: 'installment_schedule',
            entityId: s.id,
            eventType: 'schedule.admin_waive',
            fromState: 'in_collections',
            toState: 'waived',
            actorId: actor.actorId,
            actorType: actor.actorType,
            reason: input.notes ?? null,
          });
        }
      }

      const [updated] = await tx
        .update(cases)
        .set({ resolution: input.resolution, closed_at: nowIso })
        .where(eq(cases.id, caseId))
        .returning();
      if (!updated) throw new CollectionsCaseNotFoundError(caseId);

      await tx.insert(actions).values({
        case_id: caseId,
        action_type: 'note_added',
        outcome: input.resolution,
        notes: input.notes ?? null,
        performed_by: actor.actorId,
        metadata: { resolution: input.resolution, manual: true },
      });
      await this.audit.append(tx, {
        entityType: 'collections_case',
        entityId: caseId,
        eventType: 'collections_case.closed',
        fromState: c.current_stage,
        toState: input.resolution,
        reason: input.notes ?? null,
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return updated;
    });
  }

  /** All stage names in order — exposed for callers/UX. */
  static stages(): readonly CollectionsStage[] {
    return COLLECTIONS_STAGES;
  }
}
