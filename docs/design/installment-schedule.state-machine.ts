// ============================================================================
// installment-schedule.state-machine.ts
// ----------------------------------------------------------------------------
// Reference implementation for the Installment Schedule state machine.
// Hand-rolled transition table approach (no XState dependency).
//
// Why hand-rolled? Payment state machines have side effects that should live
// in services, not in machine config. Keeping the transition table as plain
// data makes it easy to test, audit, and serialize for compliance review.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. STATES
// ---------------------------------------------------------------------------

export const ScheduleStates = {
  PENDING: 'pending',
  DUE: 'due',
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
  RETRY_SCHEDULED: 'retry_scheduled',
  OVERDUE: 'overdue',
  IN_COLLECTIONS: 'in_collections',
  RESTRUCTURED: 'restructured',
  DEFAULTED: 'defaulted',
  WAIVED: 'waived',
  REFUNDED: 'refunded',
} as const;

export type ScheduleState = typeof ScheduleStates[keyof typeof ScheduleStates];

// Terminal states cannot transition further (except by admin override
// recorded as a separate audit-only correction event).
export const TerminalStates: ReadonlySet<ScheduleState> = new Set([
  ScheduleStates.DEFAULTED,
  ScheduleStates.WAIVED,
  ScheduleStates.REFUNDED,
  ScheduleStates.RESTRUCTURED,
]);

// ---------------------------------------------------------------------------
// 2. EVENTS — the only inputs that can cause a transition
// ---------------------------------------------------------------------------

export const ScheduleEvents = {
  DUE_DATE_REACHED: 'due_date_reached',
  DEBIT_INITIATED: 'debit_initiated',
  CHARGE_SUCCEEDED: 'charge_succeeded',
  CHARGE_FAILED: 'charge_failed',
  RETRYABLE: 'retryable',
  NON_RETRYABLE_DECLINE: 'non_retryable_decline',
  BACKOFF_ELAPSED: 'backoff_elapsed',
  GRACE_EXPIRED: 'grace_expired',
  UNPROCESSED_PAST_GRACE: 'unprocessed_past_grace',
  CASE_OPENED: 'case_opened',
  PAYMENT_RECOVERED: 'payment_recovered',
  RESTRUCTURE_APPROVED: 'restructure_approved',
  DEFAULT_THRESHOLD_HIT: 'default_threshold_hit',
  ADMIN_WAIVE: 'admin_waive',
  REFUND_ISSUED: 'refund_issued',
} as const;

export type ScheduleEvent = typeof ScheduleEvents[keyof typeof ScheduleEvents];

// ---------------------------------------------------------------------------
// 3. TRANSITION TABLE — the canonical source of truth
// ---------------------------------------------------------------------------

type TransitionKey = `${ScheduleState}:${ScheduleEvent}`;

const TRANSITIONS: Record<TransitionKey, ScheduleState> = {
  // Normal happy path
  'pending:due_date_reached': ScheduleStates.DUE,
  'due:debit_initiated': ScheduleStates.PROCESSING,
  'processing:charge_succeeded': ScheduleStates.PAID,

  // Failure & retry loop
  'processing:charge_failed': ScheduleStates.FAILED,
  'failed:retryable': ScheduleStates.RETRY_SCHEDULED,
  'retry_scheduled:backoff_elapsed': ScheduleStates.DUE,

  // Escalation paths
  'failed:non_retryable_decline': ScheduleStates.OVERDUE,
  'failed:grace_expired': ScheduleStates.OVERDUE,
  'due:unprocessed_past_grace': ScheduleStates.OVERDUE,
  'overdue:case_opened': ScheduleStates.IN_COLLECTIONS,

  // Collections outcomes
  'in_collections:payment_recovered': ScheduleStates.PAID,
  'in_collections:restructure_approved': ScheduleStates.RESTRUCTURED,
  'in_collections:default_threshold_hit': ScheduleStates.DEFAULTED,

  // Admin overrides
  'overdue:admin_waive': ScheduleStates.WAIVED,
  'in_collections:admin_waive': ScheduleStates.WAIVED,
  'paid:refund_issued': ScheduleStates.REFUNDED,
};

// ---------------------------------------------------------------------------
// 4. EVENT CONTEXT — payload that travels with each event
// ---------------------------------------------------------------------------
//
// actorId convention (until the users table arrives in migration 0002):
//   * Workers and scheduled jobs: SYSTEM_ACTORS.* sentinel UUIDs
//     (e.g. SYSTEM_ACTORS.DEBIT_WORKER, SYSTEM_ACTORS.SCHEDULER)
//   * Webhook handlers: SYSTEM_ACTORS.WEBHOOK (or the string 'paystack'
//     for audit_events specifically, since that column is TEXT)
//   * Admin / agent actions (Phase 3+): real user UUIDs from auth context
//   * Customer-initiated actions (Phase 3+): real customer UUIDs
//   * Tests: FIXTURE_USERS.* UUIDs from the test-fixtures package
//
// Never inline a raw UUID. Always import from SYSTEM_ACTORS or FIXTURE_USERS.
// ESLint rule `no-restricted-syntax` should flag string literals matching
// the UUID pattern outside those two modules.

export interface EventContext {
  scheduleId: string;
  /**
   * Who or what triggered this transition.
   * Either a SYSTEM_ACTORS.* UUID, a real user UUID, or (for webhooks
   * writing to audit_events) a string like 'paystack'.
   */
  actorId: string;
  actorType: 'system' | 'worker' | 'admin' | 'customer' | 'webhook' | 'merchant';
  reason?: string;          // for failures, decline codes, etc.
  providerReference?: string; // Paystack reference where applicable
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// 5. THE STATE MACHINE SERVICE
// ---------------------------------------------------------------------------

export class IllegalTransitionError extends Error {
  constructor(from: ScheduleState, event: ScheduleEvent) {
    super(`Cannot apply event "${event}" to schedule in state "${from}"`);
    this.name = 'IllegalTransitionError';
  }
}

export class TerminalStateError extends Error {
  constructor(state: ScheduleState) {
    super(`Schedule is in terminal state "${state}" and cannot transition`);
    this.name = 'TerminalStateError';
  }
}

/**
 * Computes the next state for a (currentState, event) pair.
 * Pure function — no side effects, easy to unit test.
 */
export function nextState(
  currentState: ScheduleState,
  event: ScheduleEvent,
): ScheduleState {
  if (TerminalStates.has(currentState) && event !== ScheduleEvents.REFUND_ISSUED) {
    throw new TerminalStateError(currentState);
  }

  const key: TransitionKey = `${currentState}:${event}`;
  const target = TRANSITIONS[key];

  if (!target) {
    throw new IllegalTransitionError(currentState, event);
  }

  return target;
}

/**
 * Returns whether a transition is legal without throwing.
 * Useful for UI affordances (e.g., "can this user waive this installment?").
 */
export function canTransition(
  currentState: ScheduleState,
  event: ScheduleEvent,
): boolean {
  try {
    nextState(currentState, event);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 6. SERVICE LAYER — where transitions actually get persisted
// ---------------------------------------------------------------------------
//
// Real NestJS shape. Notes:
//   * Every transition is wrapped in a DB transaction
//   * A row is appended to audit_events in the same transaction
//   * A Redis distributed lock prevents two workers racing on the same schedule
//   * Domain events are published AFTER commit, never inside the transaction

import { Injectable, Inject } from '@nestjs/common';
import { DrizzleDb } from '../shared/drizzle.provider';
import { RedisLock } from '../shared/redis-lock.service';
import { EventBus } from '../shared/event-bus.service';
import { AuditLogger } from '../audit/audit-logger.service';

@Injectable()
export class ScheduleStateService {
  constructor(
    @Inject('DB') private readonly db: DrizzleDb,
    private readonly lock: RedisLock,
    private readonly eventBus: EventBus,
    private readonly audit: AuditLogger,
  ) {}

  async applyEvent(
    event: ScheduleEvent,
    ctx: EventContext,
  ): Promise<{ from: ScheduleState; to: ScheduleState }> {
    const lockKey = `schedule:${ctx.scheduleId}`;

    return this.lock.withLock(lockKey, { ttlMs: 5000 }, async () => {
      return this.db.transaction(async (tx) => {
        // 1. Load current state (FOR UPDATE to be safe even within lock)
        const row = await tx.query.installmentSchedule.findFirst({
          where: (s, { eq }) => eq(s.id, ctx.scheduleId),
        });

        if (!row) {
          throw new Error(`Schedule ${ctx.scheduleId} not found`);
        }

        const from = row.status as ScheduleState;

        // 2. Compute target state (throws if illegal)
        const to = nextState(from, event);

        // 3. Persist new state with optimistic concurrency check on version
        const result = await tx
          .update(installmentSchedule)
          .set({
            status: to,
            version: row.version + 1,
            updatedAt: new Date(),
            // additional fields per event (e.g. paidAt on charge_succeeded)
            ...this.deriveFieldUpdates(event, ctx),
          })
          .where(and(
            eq(installmentSchedule.id, ctx.scheduleId),
            eq(installmentSchedule.version, row.version),
          ));

        if (result.rowCount === 0) {
          throw new Error('Concurrent update detected — retry');
        }

        // 4. Append immutable audit record (same transaction)
        await this.audit.append(tx, {
          entityType: 'installment_schedule',
          entityId: ctx.scheduleId,
          fromState: from,
          toState: to,
          event,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          reason: ctx.reason,
          metadata: ctx.metadata,
          occurredAt: ctx.occurredAt,
        });

        // 5. Queue domain event for after-commit publication
        tx.afterCommit(() => {
          this.eventBus.publish(`schedule.${to}`, {
            scheduleId: ctx.scheduleId,
            from,
            to,
            event,
            actorId: ctx.actorId,
            occurredAt: ctx.occurredAt,
          });
        });

        return { from, to };
      });
    });
  }

  /**
   * Maps events to additional column updates beyond status.
   * Keeps the side-effecting column writes co-located with the transition.
   */
  private deriveFieldUpdates(
    event: ScheduleEvent,
    ctx: EventContext,
  ): Record<string, unknown> {
    switch (event) {
      case ScheduleEvents.DEBIT_INITIATED:
        return {
          lastAttemptAt: ctx.occurredAt,
          attemptCount: sql`attempt_count + 1`,
        };
      case ScheduleEvents.CHARGE_SUCCEEDED:
        return {
          paidAt: ctx.occurredAt,
          providerReference: ctx.providerReference,
        };
      case ScheduleEvents.CHARGE_FAILED:
        return { lastFailureReason: ctx.reason };
      default:
        return {};
    }
  }
}

// ---------------------------------------------------------------------------
// 7. EXAMPLE: a webhook handler consuming the service
// ---------------------------------------------------------------------------

/*
import { SYSTEM_ACTORS } from '../shared/constants/system-actors';

@Controller('webhooks/paystack')
export class PaystackWebhookController {
  constructor(
    private readonly state: ScheduleStateService,
    private readonly paystack: PaystackService,
  ) {}

  @Post()
  async handle(@Headers('x-paystack-signature') sig: string, @Body() body: any) {
    this.paystack.verifySignature(sig, body);

    const attempt = await this.findAttemptByReference(body.data.reference);
    if (!attempt) return { ok: true }; // unrelated event

    const event =
      body.event === 'charge.success'
        ? ScheduleEvents.CHARGE_SUCCEEDED
        : ScheduleEvents.CHARGE_FAILED;

    await this.state.applyEvent(event, {
      scheduleId: attempt.scheduleId,
      // Webhook → audit_events.actor_id receives the sentinel WEBHOOK UUID.
      // (If you prefer the literal 'paystack' string, that also works because
      // audit_events.actor_id is TEXT, not UUID. Pick one convention and stick
      // with it across all webhook handlers.)
      actorId: SYSTEM_ACTORS.WEBHOOK,
      actorType: 'webhook',
      providerReference: body.data.reference,
      reason: body.data.gateway_response,
      metadata: { raw: body, provider: 'paystack' },
      occurredAt: new Date(body.data.paid_at ?? Date.now()),
    });

    return { ok: true };
  }
}
*/

// ---------------------------------------------------------------------------
// 8. TESTING — the table is trivially testable
// ---------------------------------------------------------------------------

/*
import { SYSTEM_ACTORS } from '../shared/constants/system-actors';
import { FIXTURE_USERS } from '../shared/test-fixtures/users';

describe('ScheduleStateMachine — pure transition function', () => {
  it('allows pending → due → processing → paid', () => {
    expect(nextState('pending', 'due_date_reached')).toBe('due');
    expect(nextState('due', 'debit_initiated')).toBe('processing');
    expect(nextState('processing', 'charge_succeeded')).toBe('paid');
  });

  it('rejects illegal transitions', () => {
    expect(() => nextState('pending', 'charge_succeeded'))
      .toThrow(IllegalTransitionError);
  });

  it('blocks transitions from terminal states (except refund from paid)', () => {
    expect(() => nextState('defaulted', 'payment_recovered'))
      .toThrow(TerminalStateError);
    expect(nextState('paid', 'refund_issued')).toBe('refunded');
  });

  it('loops through retry path', () => {
    expect(nextState('failed', 'retryable')).toBe('retry_scheduled');
    expect(nextState('retry_scheduled', 'backoff_elapsed')).toBe('due');
  });
});

describe('ScheduleStateService — integration', () => {
  it('worker-initiated debit uses the DEBIT_WORKER sentinel', async () => {
    await service.applyEvent('debit_initiated', {
      scheduleId,
      actorId: SYSTEM_ACTORS.DEBIT_WORKER,    // ← worker actor
      actorType: 'worker',
      occurredAt: new Date(),
    });

    const audit = await getAuditRow(scheduleId);
    expect(audit.actor_id).toBe(SYSTEM_ACTORS.DEBIT_WORKER);
    expect(audit.actor_type).toBe('worker');
  });

  it('admin waive uses a real (or fixture) user UUID', async () => {
    await service.applyEvent('admin_waive', {
      scheduleId,
      actorId: FIXTURE_USERS.adminJane,         // ← fixture for tests
      actorType: 'admin',
      reason: 'Customer hardship — approved by ops lead',
      occurredAt: new Date(),
    });
  });
});
*/
