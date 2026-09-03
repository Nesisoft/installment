import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { InvalidOrderTransitionError, OrderNotFoundError } from '../orders/errors';
import { FulfilmentService } from './fulfilment.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('FulfilmentService (integration)', () => {
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
  const fulfilment = new FulfilmentService(db, audit, plans);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(): Promise<string> {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Boateng',
        email: `ama-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning();
    return rows[0]!.id;
  }

  async function paidOrder(): Promise<{ orderId: string; merchantId: string }> {
    const customerId = await freshCustomer();
    const merchant = await merchants.create(
      {
        business_name: `Shop ${randomUUID().slice(0, 8)}`,
        legal_name: 'Shop Ltd',
        email: `shop-${randomUUID()}@fixture.local`,
        phone: '+233302000111',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `s-${randomUUID().slice(0, 8)}`, display_name: 'Shop' },
      ACTOR,
    );
    // Activated, both of them. A merchant is created `pending_kyc` and a store
    // `draft`, and neither may trade until somebody opens it — checkout now
    // enforces that, where before it asked only about the variant and the
    // product. This fixture never activated anything and so was quietly
    // selling from an unopened shop.
    // A merchant's first activation needs approved KYC documents behind it;
    // this fixture's subject is not KYC, so it satisfies the requirement.
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    const product = await products.create(
      {
        store_id: store.id,
        title: 'Kettle',
        base_price_pesewas: 5000,
        status: 'active',
        variants: [{ sku: `SKU-${randomUUID().slice(0, 8)}`, quantity_available: 10 }],
      },
      ACTOR,
    );
    const variantId = product.variants[0]!.id;
    await cart.addItem(customerId, { variant_id: variantId, quantity: 1 });

    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    await orders.confirmPayment(order!.id, { provider_reference: `ref-${randomUUID()}` }, ACTOR);
    return { orderId: order!.id, merchantId: merchant.id };
  }

  async function events(orderId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(schema.order_events)
      .where(eq(schema.order_events.order_id, orderId))
      .orderBy(asc(schema.order_events.occurred_at), asc(schema.order_events.created_at));
    return rows.map((r) => r.event_type);
  }

  it('walks paid → fulfilling → shipped → delivered, recording each step', async () => {
    const { orderId, merchantId } = await paidOrder();

    await fulfilment.markShipped(
      orderId,
      { courier_name: 'Swift Riders', tracking_code: 'SR-1' },
      ACTOR,
      { merchantId },
    );
    const delivered = await fulfilment.markDelivered(orderId, {}, ACTOR, { merchantId });

    expect(delivered.status).toBe('delivered');
    expect(delivered.delivered_at).not.toBeNull();
    // Shipping straight from `paid` passes through `fulfilling` on its own —
    // the state machine forbids the direct hop, and a seller should not have to
    // click twice to get a coherent timeline.
    expect(await events(orderId)).toEqual([
      'order.created',
      'order.paid',
      'order.fulfilling',
      'order.shipped',
      'order.delivered',
    ]);
  });

  it('stamps the return window from the order’s own term', async () => {
    const { orderId, merchantId } = await paidOrder();
    await fulfilment.markShipped(orderId, {}, ACTOR, { merchantId });

    const deliveredAt = new Date('2026-09-01T10:00:00.000Z');
    const order = await fulfilment.markDelivered(
      orderId,
      { delivered_at: deliveredAt.toISOString() },
      ACTOR,
      { merchantId },
    );

    const ends = new Date(order.return_window_ends_at!);
    const days = Math.round((ends.getTime() - deliveredAt.getTime()) / 86_400_000);
    expect(days).toBe(order.return_window_days);
  });

  it('records the courier without clobbering detail a later update omits', async () => {
    const { orderId, merchantId } = await paidOrder();

    await fulfilment.markShipped(
      orderId,
      { courier_name: 'Swift Riders', tracking_code: 'SR-9', courier_phone: '0244000000' },
      ACTOR,
      { merchantId },
    );
    // The rider hand-off knows the rider but not the tracking code.
    await fulfilment.markOutForDelivery(orderId, { rider_name: 'Kwame' }, ACTOR, { merchantId });

    const shipment = (
      await db.select().from(schema.shipments).where(eq(schema.shipments.order_id, orderId))
    )[0]!;
    expect(shipment.status).toBe('out_for_delivery');
    expect(shipment.rider_name).toBe('Kwame');
    expect(shipment.tracking_code).toBe('SR-9');
    expect(shipment.courier_name).toBe('Swift Riders');
  });

  it('is idempotent on delivery — a second call does not move the window', async () => {
    const { orderId, merchantId } = await paidOrder();
    await fulfilment.markShipped(orderId, {}, ACTOR, { merchantId });

    const first = await fulfilment.markDelivered(orderId, {}, ACTOR, { merchantId });
    const second = await fulfilment.markDelivered(orderId, {}, ACTOR, { merchantId });

    expect(second.return_window_ends_at).toBe(first.return_window_ends_at);
    expect((await events(orderId)).filter((e) => e === 'order.delivered')).toHaveLength(1);
  });

  it('refuses to skip delivery on an order that never shipped', async () => {
    const { orderId, merchantId } = await paidOrder();
    await expect(fulfilment.markDelivered(orderId, {}, ACTOR, { merchantId })).rejects.toThrow(
      InvalidOrderTransitionError,
    );
  });

  it('hides another merchant’s order behind the same answer as a missing one', async () => {
    const { orderId } = await paidOrder();
    const stranger = randomUUID();
    await expect(
      fulfilment.markShipped(orderId, {}, ACTOR, { merchantId: stranger }),
    ).rejects.toThrow(OrderNotFoundError);
  });

  it('closes an order once its return window has elapsed, and not before', async () => {
    const { orderId, merchantId } = await paidOrder();
    await fulfilment.markShipped(orderId, {}, ACTOR, { merchantId });
    await fulfilment.markDelivered(orderId, {}, ACTOR, { merchantId });

    // Still inside the window: nothing to close.
    expect(await fulfilment.completeElapsedReturnWindows(ACTOR, new Date())).not.toContain(orderId);

    const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)))[0]!;
    const afterWindow = new Date(new Date(order.return_window_ends_at!).getTime() + 1_000);

    expect(await fulfilment.completeElapsedReturnWindows(ACTOR, afterWindow)).toContain(orderId);

    const closed = (await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)))[0]!;
    expect(closed.status).toBe('completed');
    expect(await events(orderId)).toContain('order.completed');

    // Running the sweep again is a no-op rather than a second close.
    expect(await fulfilment.completeElapsedReturnWindows(ACTOR, afterWindow)).not.toContain(
      orderId,
    );
  });

  it('serves the tracking view a customer sees, scoped to them', async () => {
    const { orderId, merchantId } = await paidOrder();
    await fulfilment.markShipped(orderId, { courier_name: 'Swift Riders' }, ACTOR, { merchantId });

    const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)))[0]!;
    const tracking = await fulfilment.tracking(orderId, order.customer_id);

    expect(tracking?.status).toBe('shipped');
    expect(tracking?.shipment?.courier_name).toBe('Swift Riders');
    expect(tracking?.events.map((e) => e.label)).toContain('Shipped');

    // Someone else's order is simply not there.
    expect(await fulfilment.tracking(orderId, randomUUID())).toBeNull();
  });

  /**
   * Guards the uuid array binding, not the grouping. `latestEvents` filtered
   * with `sql\`${oe.order_id} = ANY(${ids})\``, which Drizzle binds as ONE
   * untyped parameter — Postgres reads it as text and the statement dies with
   * 22P02 comparing `uuid = ANY(text)`. The identical shape took down every
   * instalment quote in the catalogue before it was found, and only real
   * Postgres can tell the difference.
   */
  it('returns the latest event per order for several orders at once', async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    await fulfilment.markShipped(a.orderId, {}, ACTOR, { merchantId: a.merchantId });
    // Delivered at an explicitly later moment, so "latest" is decided by the
    // clock rather than by which row Postgres happens to return first: shipping
    // writes `order.fulfilling` and `order.shipped` in one transaction, and they
    // share an `occurred_at` to the microsecond.
    await fulfilment.markDelivered(
      a.orderId,
      { delivered_at: new Date(Date.now() + 86_400_000).toISOString() },
      ACTOR,
      { merchantId: a.merchantId },
    );

    const latest = await fulfilment.latestEvents([a.orderId, b.orderId, randomUUID()]);

    expect(latest.get(a.orderId)?.event_type).toBe('order.delivered');
    expect(latest.get(b.orderId)?.event_type).toBe('order.paid');
    expect(latest.size).toBe(2);
  });

  it('answers an empty map for no ids rather than querying for none', async () => {
    expect((await fulfilment.latestEvents([])).size).toBe(0);
  });
});
