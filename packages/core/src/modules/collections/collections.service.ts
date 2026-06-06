import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { nextScheduleStatus, type ScheduleStatus } from '../schedules/state-machine';
import {
  COLLECTIONS_STAGES,
  isLaterStage,
  stageForAge,
  type CollectionsStage,
} from './stage-policy';

const sched = schema.installment_schedule;
const cases = schema.collections_cases;
const actions = schema.collections_actions;

const DAY_MS = 86_400_000;

export type CollectionsCase = typeof schema.collections_cases.$inferSelect;

export interface CollectionsActor {
  actorId: string;
  actorType: AuditActorType;
}

export interface CollectionsSweepSummary {
  graceExpired: number;
  casesOpened: number;
  stagesAdvanced: number;
  advances: Array<{ caseId: string; from: CollectionsStage; to: CollectionsStage }>;
}

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
  ) {}

  /** Moves due/failed installments past their grace date to `overdue`. */
  async escalateGraceExpired(
    asOf: Date,
    actor: CollectionsActor,
    opts: { limit?: number } = {},
  ): Promise<number> {
    const asOfDate = asOf.toISOString().slice(0, 10);
    const candidates = await this.db
      .select({ id: sched.id, status: sched.status })
      .from(sched)
      .where(and(inArray(sched.status, ['due', 'failed']), lt(sched.grace_until_date, asOfDate)))
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
      if (from !== 'due' && from !== 'failed') return false; // raced; skip

      const event = from === 'due' ? 'unprocessed_past_grace' : 'grace_expired';
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
      return true;
    });
  }

  /** Runs the full daily collections sweep in order. */
  async runSweep(
    actor: CollectionsActor,
    asOf: Date = new Date(),
  ): Promise<CollectionsSweepSummary> {
    const graceExpired = await this.escalateGraceExpired(asOf, actor);
    const casesOpened = await this.openCasesForOverdue(actor, asOf);
    const advances = await this.advanceStages(asOf, actor);
    return {
      graceExpired,
      casesOpened,
      stagesAdvanced: advances.length,
      advances,
    };
  }

  /** All stage names in order — exposed for callers/UX. */
  static stages(): readonly CollectionsStage[] {
    return COLLECTIONS_STAGES;
  }
}
