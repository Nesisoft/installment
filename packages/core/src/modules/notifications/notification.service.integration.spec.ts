import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { NotificationService, type NotificationSmsSender } from './notification.service';
import { DevicesService } from './devices.service';
import { PushNotifier, type PushSender } from './push-notifier.service';

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

/**
 * The push companion, against real rows.
 *
 * Every template this service renders is a money notice — a missed debit costs
 * the customer a late fee — so the SMS is unconditional and the push is an
 * addition for whoever has the app. These tests pin that arrangement in both
 * directions: the push happens, and it never becomes the only channel.
 */
describe.skipIf(!RUN_DB)('NotificationService push companion (integration)', () => {
  const { db, pool } = createTestDb();
  const devices = new DevicesService(db);

  afterAll(async () => {
    await pool.end();
  });

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

  function stubPush() {
    const sent: { to: string; title: string; body: string; data?: Record<string, unknown> }[] = [];
    const sender: PushSender = {
      send: async (message) => {
        sent.push(message);
        return { status: 'sent', id: `t-${sent.length}`, rawResponse: {} };
      },
    };
    return { notifier: new PushNotifier(db, devices, sender), sent };
  }

  async function customerWithHandset() {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Mensah',
        email: `notif-push-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    const customerId = rows[0]!.id;
    const token = `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;
    await devices.register({ customerId }, { expo_token: token, platform: 'android' });
    return { customerId, token };
  }

  const channelRows = (recipientId: string, channel: string) =>
    db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.recipient_id, recipientId),
          eq(schema.notifications.channel, channel),
        ),
      );

  it('sends the SMS and pushes the same message', async () => {
    const { customerId, token } = await customerWithHandset();
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    await new NotificationService(db, sms, 'Installmt', push).sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(token);
    // The push rendering, not the SMS sentence.
    expect(sent[0]?.title).toBe('GHS 250.00 due 2026-06-20');
    expect(sent[0]?.body).not.toContain('- Installment');
    expect(sent[0]?.data).toMatchObject({ kind: 'pre_debit_reminder' });

    // One row per channel: the log has to be able to answer "how was this
    // customer told" and "did it arrive", separately per channel.
    expect(await channelRows(customerId, 'sms')).toHaveLength(1);
    expect(await channelRows(customerId, 'push')).toHaveLength(1);
  });

  it('still pushes when the SMS provider is down', async () => {
    // The moment the second channel earns its keep. Skipping the push because
    // the first attempt failed would leave the customer told nothing at all.
    const { customerId } = await customerWithHandset();
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = {
      send: vi.fn(async () => {
        throw new Error('Arkesel 503');
      }),
    };

    const { status } = await new NotificationService(db, sms, 'Installmt', push).sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(status).toBe('failed');
    expect(sent).toHaveLength(1);
    const [row] = await channelRows(customerId, 'sms');
    expect(row?.status).toBe('failed');
    expect((await channelRows(customerId, 'push'))[0]?.status).toBe('sent');
  });

  it('sends the SMS regardless when the buyer has no handset', async () => {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Kojo',
        last_name: 'Asante',
        email: `notif-nopush-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    const customerId = rows[0]!.id;
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    await new NotificationService(db, sms, 'Installmt', push).sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(await channelRows(customerId, 'push')).toHaveLength(0);
  });

  it('does not push to a merchant recipient', async () => {
    // These templates address a customer by name about their own instalment.
    // A merchant's handsets are notified about orders, by their own notifier.
    const { customerId } = await customerWithHandset();
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    await new NotificationService(db, sms, 'Installmt', push).send({
      recipientType: 'merchant',
      recipientId: customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('behaves exactly as before with no push sender wired', async () => {
    const { customerId } = await customerWithHandset();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    const { status } = await new NotificationService(db, sms, 'Installmt').sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      ...REMINDER,
    });

    expect(status).toBe('sent');
    expect(await channelRows(customerId, 'push')).toHaveLength(0);
  });

  it('carries extra deep-link keys through to the push payload', async () => {
    const { customerId } = await customerWithHandset();
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    await new NotificationService(db, sms, 'Installmt', push).sendToCustomer({
      customerId,
      toAddress: '+233244000000',
      pushData: { planId: 'plan-1' },
      ...REMINDER,
    });

    expect(sent[0]?.data).toMatchObject({ kind: 'pre_debit_reminder', planId: 'plan-1' });
  });

  it('refuses a half-rendered message on both channels, not one', async () => {
    // The push rendering is validated before the SMS goes out, so a template
    // with a missing variable fails the whole send rather than reaching the
    // customer on one channel and not the other.
    const { customerId } = await customerWithHandset();
    const { notifier: push, sent } = stubPush();
    const sms: NotificationSmsSender = { send: vi.fn(async () => ({ status: 'sent' })) };

    await expect(
      new NotificationService(db, sms, 'Installmt', push).sendToCustomer({
        customerId,
        toAddress: '+233244000000',
        templateId: 'payment_succeeded',
        variables: { name: 'Ama' },
      }),
    ).rejects.toThrow();

    expect(sms.send).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(await channelRows(customerId, 'sms')).toHaveLength(0);
  });
});
