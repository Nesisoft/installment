import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { NotificationService, type NotificationSmsSender } from './notification.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('NotificationService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });

  afterAll(async () => {
    await pool.end();
  });

  function load(id: string) {
    return db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  }

  it('records a sent notification (queued → sent) with the provider message id', async () => {
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ id: 'hubtel-123' })) };
    const notifier = new NotificationService(db, sms, 'Installmt');
    const customerId = randomUUID();

    const { notification, status } = await notifier.sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      templateId: 'pre_debit_reminder',
      variables: {
        name: 'Ama',
        amount: '250.00',
        date: '2026-06-20',
        provider: 'mtn',
        phone: '0244000000',
      },
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
