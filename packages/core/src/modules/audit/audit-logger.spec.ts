import { describe, expect, it, vi } from 'vitest';
import {
  AuditError,
  AuditLogger,
  type AuditEntry,
  type AuditExecutor,
} from './audit-logger.service';

function makeExec() {
  const values = vi.fn((_row: Record<string, unknown>) => Promise.resolve(undefined));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { exec: { insert } as unknown as AuditExecutor, insert, values };
}

const baseEntry: AuditEntry = {
  entityType: 'installment_schedule',
  entityId: '11111111-1111-1111-1111-111111111111',
  eventType: 'charge_succeeded',
  fromState: 'processing',
  toState: 'paid',
  actorId: '00000000-0000-0000-0000-000000000004',
  actorType: 'webhook',
  reason: 'charge.success',
  metadata: { provider: 'paystack' },
};

describe('AuditLogger.append', () => {
  it('inserts the mapped row using the caller-supplied executor', async () => {
    const { exec, insert, values } = makeExec();
    await new AuditLogger().append(exec, baseEntry);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]![0]).toMatchObject({
      entity_type: 'installment_schedule',
      entity_id: '11111111-1111-1111-1111-111111111111',
      event_type: 'charge_succeeded',
      from_state: 'processing',
      to_state: 'paid',
      actor_id: '00000000-0000-0000-0000-000000000004',
      actor_type: 'webhook',
      reason: 'charge.success',
      metadata: { provider: 'paystack' },
    });
  });

  it('defaults nullable fields and serializes occurredAt to ISO when supplied', async () => {
    const { exec, values } = makeExec();
    const occurredAt = new Date('2026-01-15T08:30:00.000Z');
    await new AuditLogger().append(exec, {
      entityType: 'customer_plan',
      entityId: '22222222-2222-2222-2222-222222222222',
      eventType: 'plan_completed',
      actorId: '00000000-0000-0000-0000-000000000007',
      actorType: 'worker',
      occurredAt,
    });

    expect(values.mock.calls[0]![0]).toMatchObject({
      from_state: null,
      to_state: null,
      reason: null,
      metadata: {},
      occurred_at: '2026-01-15T08:30:00.000Z',
    });
  });

  it('omits occurred_at when not supplied so the DB default applies', async () => {
    const { exec, values } = makeExec();
    await new AuditLogger().append(exec, baseEntry);
    expect(values.mock.calls[0]![0]).not.toHaveProperty('occurred_at');
  });

  it('rejects an invalid actorType', async () => {
    const { exec, insert } = makeExec();
    const bad = { ...baseEntry, actorType: 'robot' } as unknown as AuditEntry;
    await expect(new AuditLogger().append(exec, bad)).rejects.toThrow(AuditError);
    await expect(new AuditLogger().append(exec, bad)).rejects.toThrow(/actorType "robot"/);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects missing required fields', async () => {
    const { exec, insert } = makeExec();
    const logger = new AuditLogger();
    await expect(logger.append(exec, { ...baseEntry, entityType: '' })).rejects.toThrow(
      /entityType/,
    );
    await expect(logger.append(exec, { ...baseEntry, entityId: '' })).rejects.toThrow(/entityId/);
    await expect(logger.append(exec, { ...baseEntry, eventType: '' })).rejects.toThrow(/eventType/);
    await expect(logger.append(exec, { ...baseEntry, actorId: '' })).rejects.toThrow(/actorId/);
    expect(insert).not.toHaveBeenCalled();
  });
});
