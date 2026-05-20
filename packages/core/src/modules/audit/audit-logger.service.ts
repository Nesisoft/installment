import { schema, type Database } from '@installment/db';

const auditEvents = schema.audit_events;

/** Matches audit_events.actor_type CHECK constraint. */
export const AUDIT_ACTOR_TYPES = [
  'system',
  'worker',
  'admin',
  'customer',
  'webhook',
  'merchant',
] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEntry {
  entityType: string;
  /** UUID of the row being audited (e.g. installment_schedule.id). */
  entityId: string;
  /** Transition / domain event name (e.g. 'charge_succeeded'). */
  eventType: string;
  fromState?: string | null;
  toState?: string | null;
  /**
   * SYSTEM_ACTORS.* UUID, a real user UUID, or a string literal like
   * 'paystack' (audit_events.actor_id is TEXT — by design — and is NEVER
   * FK-constrained, even after 0002).
   */
  actorId: string;
  actorType: AuditActorType;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Defaults to NOW() in the DB when omitted. */
  occurredAt?: Date;
}

/** Just enough of the Drizzle surface to insert one row. */
export type AuditExecutor = Pick<Database, 'insert'>;

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

const ACTOR_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_ACTOR_TYPES);

/**
 * Append-only audit log writer.
 *
 * `append(tx, entry)` inserts one row into audit_events using the caller's
 * transaction, so the audit row commits atomically with the state change it
 * describes (Guiding principle #4 & #6). The table itself blocks UPDATE/DELETE
 * via a DB trigger — this service is the only writer.
 */
export class AuditLogger {
  async append(tx: AuditExecutor, entry: AuditEntry): Promise<void> {
    this.validate(entry);

    await tx.insert(auditEvents).values({
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      event_type: entry.eventType,
      from_state: entry.fromState ?? null,
      to_state: entry.toState ?? null,
      actor_id: entry.actorId,
      actor_type: entry.actorType,
      reason: entry.reason ?? null,
      metadata: entry.metadata ?? {},
      ...(entry.occurredAt ? { occurred_at: entry.occurredAt.toISOString() } : {}),
    });
  }

  private validate(entry: AuditEntry): void {
    if (!entry.entityType) throw new AuditError('entityType is required');
    if (!entry.entityId) throw new AuditError('entityId is required');
    if (!entry.eventType) throw new AuditError('eventType is required');
    if (!entry.actorId) throw new AuditError('actorId is required');
    if (!ACTOR_TYPE_SET.has(entry.actorType)) {
      throw new AuditError(`Invalid actorType "${entry.actorType}"`);
    }
  }
}
