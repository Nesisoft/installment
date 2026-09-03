import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { DevicesService } from './devices.service';
import { PushNotifier, type PushSender } from './push-notifier.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

interface StubOptions {
  /** Per-call outcomes, cycled. `throw` simulates the provider being down. */
  outcomes?: ({ status: 'sent'; id?: string } | { status: 'failed'; error: string } | 'throw')[];
}

function stubPush(opts: StubOptions = {}) {
  const sent: { to: string; title: string; body: string; data?: Record<string, unknown> }[] = [];
  let n = 0;
  const sender: PushSender = {
    send: async (message) => {
      sent.push(message);
      const outcome = opts.outcomes?.[n++] ?? { status: 'sent' as const, id: `ticket-${n}` };
      if (outcome === 'throw') throw new Error('Expo unreachable');
      return { ...outcome, rawResponse: {} };
    },
  };
  return { sender, sent };
}

/**
 * The transport, against real rows.
 *
 * This is the spec that would have caught the thing this whole slice exists to
 * fix: `push_devices` shipped in 0015, the customer app posted tokens to it,
 * and nothing ever read them — `listActive` had no callers anywhere in the
 * repo. A unit test over a fake device list would have passed just as happily
 * with no transport at all, so the assertions here are about what lands in
 * `notifications` and what happens to a token the provider disowns.
 */
describe.skipIf(!RUN_DB)('PushNotifier (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const devices = new DevicesService(db);
  const merchants = new MerchantsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const token = () => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

  async function merchantWithHandsets(count: number) {
    const s = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Adepa ${s}`,
        legal_name: `Adepa Ghana ${s}`,
        email: `ops+${s}@adepa.gh`,
        phone: '+233244123456',
      },
      ACTOR,
    );
    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = token();
      tokens.push(t);
      await devices.register({ merchantId: merchant.id }, { expo_token: t, platform: 'android' });
    }
    return { merchant, tokens };
  }

  async function pushRows(merchantId: string) {
    return db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.recipient_id, merchantId),
          eq(schema.notifications.channel, 'push'),
        ),
      );
  }

  // ------------------------------------------------------------------ sending

  it('writes a push notification row per handset and marks it sent', async () => {
    const { merchant, tokens } = await merchantWithHandsets(2);
    const { sender, sent } = stubPush();
    const notifier = new PushNotifier(db, devices, sender);

    const outcome = await notifier.notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-AAAA1111',
      itemSummary: 'Ankara Wrap Dress',
      totalGhs: 'GHS 320.00',
    });

    expect(outcome).toMatchObject({ sent: 2, failed: 0, deactivated: 0, noDevices: false });
    expect(sent.map((m) => m.to).sort()).toEqual([...tokens].sort());

    // The row is the audit trail for a message: `channel: 'push'` has been
    // permitted by the notifications CHECK since 0000 and never written until
    // now.
    const rows = await pushRows(merchant.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows.every((r) => r.recipient_type === 'merchant')).toBe(true);
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);
    expect(rows.every((r) => r.template_id === 'merchant.order_placed')).toBe(true);
  });

  it('carries the order id so the app can open the order, not the dashboard', async () => {
    const { merchant } = await merchantWithHandsets(1);
    const { sender, sent } = stubPush();
    const orderId = randomUUID();

    await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId,
      orderNumber: 'ORD-20260903-BBBB2222',
      itemSummary: 'Kente Trim Blazer',
      totalGhs: 'GHS 640.00',
    });

    expect(sent[0]?.data).toMatchObject({ kind: 'order_placed', orderId });
    expect(sent[0]?.title).toBe('New order to confirm');
  });

  it('does nothing, and says so, when no handset is registered', async () => {
    const { merchant } = await merchantWithHandsets(0);
    const { sender, sent } = stubPush();

    const outcome = await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-CCCC3333',
      itemSummary: 'Headwrap set',
      totalGhs: 'GHS 180.00',
    });

    // Not a failure: the merchant has not installed the app. Writing a `failed`
    // row for that would fill the log with something nobody can act on.
    expect(outcome).toMatchObject({ noDevices: true, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    expect(await pushRows(merchant.id)).toHaveLength(0);
  });

  // ----------------------------------------------------------------- failures

  it('records a refusal against the row without throwing', async () => {
    const { merchant } = await merchantWithHandsets(1);
    const { sender } = stubPush({ outcomes: [{ status: 'failed', error: 'MessageTooBig' }] });

    const outcome = await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-DDDD4444',
      itemSummary: 'Batakari Shirt',
      totalGhs: 'GHS 450.00',
    });

    expect(outcome).toMatchObject({ sent: 0, failed: 1, deactivated: 0 });
    const [row] = await pushRows(merchant.id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('MessageTooBig');
  });

  it('deactivates a handset the provider has disowned', async () => {
    // The one failure that means something to the database. Without this every
    // subsequent notification burns a request on a phone that has uninstalled
    // the app, forever.
    const { merchant, tokens } = await merchantWithHandsets(1);
    const { sender } = stubPush({
      outcomes: [{ status: 'failed', error: 'DeviceNotRegistered' }],
    });

    const outcome = await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-EEEE5555',
      itemSummary: 'Wrap dress',
      totalGhs: 'GHS 320.00',
    });

    expect(outcome).toMatchObject({ failed: 1, deactivated: 1 });
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(0);

    const rows = await db
      .select()
      .from(schema.push_devices)
      .where(eq(schema.push_devices.expo_token, tokens[0]!));
    // Deactivated, not deleted: the handset existed and the row says so.
    expect(rows[0]?.is_active).toBe(false);
  });

  it('keeps a handset active when the provider itself is down', async () => {
    // A transport failure is not the token's fault, so deactivating on it
    // would quietly unsubscribe every merchant during an Expo outage.
    const { merchant } = await merchantWithHandsets(1);
    const { sender } = stubPush({ outcomes: ['throw'] });

    const outcome = await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-FFFF6666',
      itemSummary: 'Wrap dress',
      totalGhs: 'GHS 320.00',
    });

    expect(outcome).toMatchObject({ failed: 1, deactivated: 0 });
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);
    const [row] = await pushRows(merchant.id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('Expo unreachable');
  });

  it('keeps sending to the rest when one handset fails', async () => {
    const { merchant } = await merchantWithHandsets(3);
    const { sender, sent } = stubPush({
      outcomes: [
        { status: 'sent' },
        { status: 'failed', error: 'MessageTooBig' },
        { status: 'sent' },
      ],
    });

    const outcome = await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-7777AAAA',
      itemSummary: 'Wrap dress',
      totalGhs: 'GHS 320.00',
    });

    expect(sent).toHaveLength(3);
    expect(outcome).toMatchObject({ sent: 2, failed: 1 });
  });

  it('never sends to a handset that has signed out', async () => {
    const { merchant, tokens } = await merchantWithHandsets(2);
    await devices.deactivate({ merchantId: merchant.id }, tokens[0]!);
    const { sender, sent } = stubPush();

    await new PushNotifier(db, devices, sender).notifyMerchantOfOrder({
      merchantId: merchant.id,
      orderId: randomUUID(),
      orderNumber: 'ORD-20260903-8888BBBB',
      itemSummary: 'Wrap dress',
      totalGhs: 'GHS 320.00',
    });

    expect(sent.map((m) => m.to)).toEqual([tokens[1]]);
  });
});
