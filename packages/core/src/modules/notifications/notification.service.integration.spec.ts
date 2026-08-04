import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { NotificationService, type NotificationSmsSender } from './notification.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('NotificationService (integration)', () => {
  const { db, pool } = createTestDb();

  afterAll(async () => {
    await pool.end();
  });

  function load(id: string) {
    return db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  }

  const REMINDER = {
    templateId: 'pre_debit_reminder' as const,
    variables: {
      name: 'Ama',
      amount: '250.00',
      date: '2026-06-20',
      provider: 'mtn',
      phone: '0244000000',
    },
  };

  it('records a notification the provider says it sent', async () => {
    const sms: NotificationSmsSender = {
      send: vi.fn(async () => ({ id: 'hubtel-123', status: 'sent' })),
    };
    const notifier = new NotificationService(db, sms, 'Installmt');
    const customerId = randomUUID();

    const { notification, status } = await notifier.sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(status).toBe('sent');
    expect(notification.status).toBe('sent');
    expect(notification.recipient_type).toBe('customer');
    expect(notification.recipient_id).toBe(customerId);
    expect(notification.channel).toBe('sms');
    expect(notification.provider_message_id).toBe('hubtel-123');
    expect(notification.sent_at).not.toBeNull();
    expect(sms.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+233244000000', sender: 'Installmt' }),
    );

    const [persisted] = await load(notification.id);
    expect(persisted!.status).toBe('sent');
  });

  it('leaves a notification queued when the provider only accepted it', async () => {
    // Ghanaian aggregators accept and queue; delivery comes later or not at
    // all. Stamping `sent` on acceptance made the table assert a delivery
    // nobody had confirmed — and made the console sender, which delivers
    // nothing at all, indistinguishable from a real one.
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ id: 'arkesel-9' })) };
    const notifier = new NotificationService(db, sms, 'Installmt');

    const { notification, status } = await notifier.sendToCustomer({
      customerId: randomUUID(),
      toAddress: '+233244000001',
      ...REMINDER,
    });

    expect(status).toBe('queued');
    expect(notification.status).toBe('queued');
    expect(notification.provider_message_id).toBe('arkesel-9'); // still traceable
    expect(notification.sent_at).toBeNull(); // nothing to timestamp yet
  });

  it('records a failed notification when the provider throws (never bubbles)', async () => {
    const sms: NotificationSmsSender = {
      send: vi.fn(async () => {
        throw new Error('provider 500');
      }),
    };
    const notifier = new NotificationService(db, sms, 'Installmt');

    const { notification, status } = await notifier.send({
      recipientType: 'customer',
      recipientId: randomUUID(),
      toAddress: '+233200000000',
      templateId: 'payment_failed',
      variables: { name: 'Kofi', amount: '99.00' },
    });

    expect(status).toBe('failed');
    expect(notification.status).toBe('failed');
    expect(notification.failure_reason).toContain('provider 500');
    expect(notification.failed_at).not.toBeNull();
  });
});
