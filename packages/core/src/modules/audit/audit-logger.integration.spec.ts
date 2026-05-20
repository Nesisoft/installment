import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { AuditLogger } from './audit-logger.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('AuditLogger (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const events = schema.audit_events;

  afterAll(async () => {
    await pool.end();
  });

  const findFor = async (entityId: string) =>
    db.select().from(events).where(eq(events.entity_id, entityId));

  it('commits the row alongside the caller transaction', async () => {
    const entityId = randomUUID();
    const hook = vi.fn();

    await runInTransaction(db, async (tx) => {
      await audit.append(tx, {
        entityType: 'installment_schedule',
        entityId,
        eventType: 'charge_succeeded',
        fromState: 'processing',
        toState: 'paid',
        actorId: '00000000-0000-0000-0000-000000000004',
        actorType: 'webhook',
        reason: 'charge.success',
        metadata: { provider: 'paystack' },
      });
      tx.afterCommit(hook);
    });

    expect(hook).toHaveBeenCalledTimes(1);
    const rows = await findFor(entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: 'installment_schedule',
      event_type: 'charge_succeeded',
      from_state: 'processing',
      to_state: 'paid',
      actor_type: 'webhook',
    });
  });

  it('rolls back the row when the caller transaction throws', async () => {
    const entityId = randomUUID();

    await expect(
      runInTransaction(db, async (tx) => {
        await audit.append(tx, {
          entityType: 'customer_plan',
          entityId,
          eventType: 'plan_approved',
          actorId: '00000000-0000-0000-0000-000000000001',
          actorType: 'system',
        });
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');

    expect(await findFor(entityId)).toHaveLength(0);
  });

  it('is append-only: UPDATE and DELETE are blocked by the DB trigger', async () => {
    const entityId = randomUUID();
    await audit.append(db, {
      entityType: 'merchant',
      entityId,
      eventType: 'merchant_activated',
      actorId: '00000000-0000-0000-0000-000000000001',
      actorType: 'system',
    });

    const fullMessage = (err: unknown): string => {
      const e = err as Error & { cause?: { message?: string } };
      return `${e.message ?? ''}\n${e.cause?.message ?? ''}`;
    };

    let updateErr: unknown;
    try {
      await db.update(events).set({ reason: 'tampered' }).where(eq(events.entity_id, entityId));
    } catch (e) {
      updateErr = e;
    }
    expect(updateErr).toBeDefined();
    expect(fullMessage(updateErr)).toMatch(/append-only/);

    let deleteErr: unknown;
    try {
      await db
        .delete(events)
        .where(and(eq(events.entity_id, entityId), eq(events.entity_type, 'merchant')));
    } catch (e) {
      deleteErr = e;
    }
    expect(deleteErr).toBeDefined();
    expect(fullMessage(deleteErr)).toMatch(/append-only/);
  });
});
