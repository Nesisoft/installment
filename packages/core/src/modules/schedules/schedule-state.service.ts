import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { RedisLock } from '../../shared/lock/redis-lock';
import { EventBus } from '../../shared/event-bus/event-bus';
import { nextScheduleStatus, type ScheduleEvent, type ScheduleStatus } from './state-machine';
import { ScheduleConcurrencyError, ScheduleNotFoundError } from './errors';
import type { InstallmentScheduleRow } from './customer-plans.service';

const sched = schema.installment_schedule;

export interface ScheduleEventContext {
  actorId: string;
  actorType: AuditActorType;
  reason?: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
  /** Defaults to now. */
  occurredAt?: Date;
}

export interface ScheduleTransition {
  from: ScheduleStatus;
  to: ScheduleStatus;
  row: InstallmentScheduleRow;
}

/**
 * Applies a single state-machine event to one installment, persisting the new
 * status, an immutable audit row, and any event-specific column writes in one
 * transaction. A Redis lock serialises transitions on the same schedule and an
 * optimistic version check is the second line of defence; the domain event is
 * published only after the transaction commits.
 */
export class ScheduleStateService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    private readonly lock: RedisLock,
    private readonly eventBus?: EventBus,
  ) {}

  async applyEvent(
    scheduleId: string,
    event: ScheduleEvent,
    ctx: ScheduleEventContext,
  ): Promise<ScheduleTransition> {
    const occurredAt = ctx.occurredAt ?? new Date();
    const occurredIso = occurredAt.toISOString();

    return this.lock.withLock(`schedule:${scheduleId}`, { ttlMs: 5_000 }, () =>
      runInTransaction(this.db, async (tx) => {
        const current = (
          await tx.select().from(sched).where(eq(sched.id, scheduleId)).for('update').limit(1)
        )[0];
        if (!current) throw new ScheduleNotFoundError(scheduleId);

        const from = current.status as ScheduleStatus;
        const to = nextScheduleStatus(from, event); // throws on illegal / terminal

        const patch: Partial<typeof sched.$inferInsert> = {
          status: to,
          version: current.version + 1,
          status_changed_at: occurredIso,
        };
        if (event === 'debit_initiated') {
          patch.last_attempt_at = occurredIso;
          patch.attempt_count = current.attempt_count + 1;
        } else if (event === 'charge_succeeded') {
          patch.paid_at = occurredIso;
          if (ctx.providerReference) patch.provider_reference = ctx.providerReference;
        } else if (event === 'charge_failed') {
          patch.last_failure_reason = ctx.reason ?? null;
        }

        const updated = await tx
          .update(sched)
          .set(patch)
          .where(and(eq(sched.id, scheduleId), eq(sched.version, current.version)))
          .returning();
        const row = updated[0];
        if (!row) throw new ScheduleConcurrencyError(scheduleId);

        await this.audit.append(tx, {
          entityType: 'installment_schedule',
          entityId: scheduleId,
          eventType: `schedule.${event}`,
          fromState: from,
          toState: to,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          reason: ctx.reason,
          metadata: ctx.metadata,
          occurredAt,
        });

        const bus = this.eventBus;
        if (bus) {
          tx.afterCommit(() =>
            bus.publish(`schedule.${to}`, { scheduleId, from, to, event, actorId: ctx.actorId }),
          );
        }

        return { from, to, row };
      }),
    );
  }
}
