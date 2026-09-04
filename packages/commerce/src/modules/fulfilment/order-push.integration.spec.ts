import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  DevicesService,
  LedgerService,
  MerchantsService,
  PushNotifier,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
  type PushSender,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { FulfilmentService } from './fulfilment.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The reachability proof for the buyer's half of push.
 *
 * The merchant's half shipped first and this is the mirror of it, for the same
 * reason: `push_devices` was write-only for four migrations, and the customer
 * app has been posting tokens to `/me/devices` since 0015 with nothing on the
 * other end. Every fulfilment step already wrote an `order_events` row — the
 * timeline the app renders — and told nobody. A customer who did not open the
 * app learned nothing about their own delivery.
 *
 * So nothing here asserts against a fake order. Each test drives a real
 * checkout and a real fulfilment transition through `FulfilmentService`, with a
 * real `PushNotifier` over real `push_devices` rows, and stubs only the wire.
 * If the announcement were removed, this file fails.
 */
describe.skipIf(!RUN_DB)('a fulfilment step notifies the buyer (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const applications = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const cart = new CartService(db);
  const devices = new DevicesService(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const delivered: { to: string; title: string; body: string; data?: Record<string, unknown> }[] =
    [];
  const sender: PushSender = {
    send: async (message) => {
      delivered.push(message);
      return { status: 'sent', id: `ticket-${delivered.length}`, rawResponse: {} };
    },
  };

  const notifier = new PushNotifier(db, devices, sender);
  const fulfilment = new FulfilmentService(db, audit, plans, notifier);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);

  afterAll(async () => {
    await pool.end();
  });

  async function shopper(handsets = 1) {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Boateng',
        email: `push-buyer-${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    const customerId = rows[0]!.id;

    const tokens: string[] = [];
    for (let i = 0; i < handsets; i++) {
      const t = `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;
      tokens.push(t);
      await devices.register({ customerId }, { expo_token: t, platform: 'android' });
    }
    return { customerId, tokens };
  }

  async function shop() {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Shop ${id}`,
        legal_name: `Shop Ltd ${id}`,
        email: `shop+${id}@example.gh`,
        phone: '+233244555555',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `shop-${id.slice(0, 8)}`, display_name: 'Shop' },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id };
  }

  /** A paid order, ready for the seller to pack. */
  async function paidOrder(opts: { handsets?: number } = {}) {
    delivered.length = 0;
    const { customerId, tokens } = await shopper(opts.handsets ?? 1);
    const { storeId } = await shop();
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Ankara Wrap Dress',
        base_price_pesewas: 32_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 10 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      order!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    // The merchant's own push fired on payment; this spec is about the buyer's.
    delivered.length = 0;
    return { orderId: paid.id, orderNumber: paid.order_number, customerId, tokens };
  }

  async function customerPushRows(customerId: string) {
    return db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.recipient_id, customerId),
          eq(schema.notifications.channel, 'push'),
        ),
      );
  }

  // ------------------------------------------------------------------ shipped

  it('tells the buyer when their order ships, in the timeline’s own words', async () => {
    const { orderId, orderNumber, customerId, tokens } = await paidOrder();

    await fulfilment.markShipped(orderId, { courier_name: 'Swift Riders' }, ACTOR);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe(tokens[0]);
    expect(delivered[0]?.title).toBe('Shipped');
    // The same sentence `order_events` recorded, so the tray and the order
    // screen cannot come to disagree.
    expect(delivered[0]?.body).toBe('On its way with Swift Riders.');
    expect(delivered[0]?.data).toMatchObject({ kind: 'order.shipped', orderId, orderNumber });

    const rows = await customerPushRows(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_type: 'customer', status: 'sent' });
  });

  it('reaches every handset the buyer has', async () => {
    const { orderId, tokens } = await paidOrder({ handsets: 2 });

    await fulfilment.markShipped(orderId, { courier_name: 'Swift Riders' }, ACTOR);

    expect(delivered.map((d) => d.to).sort()).toEqual([...tokens].sort());
  });

  it('names the order when there is no courier and no note', async () => {
    const { orderId, orderNumber } = await paidOrder();

    await fulfilment.markShipped(orderId, {}, ACTOR);

    // Never an empty body: a notification with a title and nothing under it
    // reads as a bug in the app.
    expect(delivered[0]?.body).toBe(`Order ${orderNumber}`);
  });

  // -------------------------------------------------------- out for delivery

  it('tells the buyer when it is out with a rider, and names the rider', async () => {
    const { orderId } = await paidOrder();
    await fulfilment.markShipped(orderId, { courier_name: 'Swift Riders' }, ACTOR);
    delivered.length = 0;

    await fulfilment.markOutForDelivery(orderId, { rider_name: 'Kofi' }, ACTOR);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.title).toBe('Out for delivery');
    expect(delivered[0]?.body).toBe('Kofi is on the way.');
    expect(delivered[0]?.data).toMatchObject({ kind: 'order.out_for_delivery' });
  });

  // ---------------------------------------------------------------- delivered

  it('tells the buyer it arrived, and says who signed for it', async () => {
    const { orderId } = await paidOrder();
    await fulfilment.markShipped(orderId, { courier_name: 'Swift Riders' }, ACTOR);
    delivered.length = 0;

    await fulfilment.markDelivered(orderId, { received_by: 'Ama' }, ACTOR);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.title).toBe('Delivered');
    expect(delivered[0]?.body).toBe('Received by Ama.');
  });

  it('says “Collected” for a pickup order, matching the timeline', async () => {
    const { orderId } = await paidOrder();
    // A hub as well as the method: `orders_pickup_needs_hub` requires the two
    // to agree, and it is right to — a pickup order with nowhere to collect
    // from is not a pickup order. Forcing the column alone is refused.
    const hub = (
      await db
        .insert(schema.pickup_hubs)
        .values({ name: 'Circle MoMo Hub', region: 'Greater Accra', city: 'Accra' })
        .returning({ id: schema.pickup_hubs.id })
    )[0]!;
    await db
      .update(schema.orders)
      .set({ fulfilment_method: 'pickup', pickup_hub_id: hub.id })
      .where(eq(schema.orders.id, orderId));
    await fulfilment.markShipped(orderId, {}, ACTOR);
    delivered.length = 0;

    await fulfilment.markDelivered(orderId, { received_by: 'Ama' }, ACTOR);

    expect(delivered[0]?.title).toBe('Collected');
  });

  // ------------------------------------------------------------- degradation

  it('does not notify for “being prepared”', async () => {
    // A buzz for "the seller is packing your order" is noise, and `markShipped`
    // passes through `fulfilling` implicitly — so announcing it would mean two
    // notifications for one action a seller took once.
    const { orderId, customerId } = await paidOrder();

    await fulfilment.startFulfilment(orderId, ACTOR);

    expect(delivered).toHaveLength(0);
    expect(await customerPushRows(customerId)).toHaveLength(0);
  });

  it('ships the order anyway when the buyer has no handset', async () => {
    const { orderId, customerId } = await paidOrder({ handsets: 0 });

    const shipped = await fulfilment.markShipped(orderId, { courier_name: 'Swift' }, ACTOR);

    expect(shipped.status).toBe('shipped');
    expect(delivered).toHaveLength(0);
    expect(await customerPushRows(customerId)).toHaveLength(0);
  });

  it('delivers the order anyway when the push transport is down', async () => {
    // The delivery physically happened. A provider outage must not roll it
    // back, and it must not stop the reserve clock either.
    const { orderId } = await paidOrder();
    await fulfilment.markShipped(orderId, {}, ACTOR);

    const exploding = new FulfilmentService(db, audit, plans, {
      notifyCustomerOfOrderEvent: () => Promise.reject(new Error('Expo unreachable')),
    });

    const done = await exploding.markDelivered(orderId, { received_by: 'Ama' }, ACTOR);

    expect(done.status).toBe('delivered');
    expect(done.delivered_at).not.toBeNull();
    expect(done.return_window_ends_at).not.toBeNull();
  });

  it('still writes the timeline row when there is no notifier at all', async () => {
    // The unwired case, which is every deployment before this slice: the
    // timeline is the record and the push is an addition to it.
    const { orderId } = await paidOrder();
    const bare = new FulfilmentService(db, audit, plans);

    await bare.markShipped(orderId, { courier_name: 'Swift' }, ACTOR);

    const events = await db
      .select()
      .from(schema.order_events)
      .where(
        and(
          eq(schema.order_events.order_id, orderId),
          eq(schema.order_events.event_type, 'order.shipped'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });
});
