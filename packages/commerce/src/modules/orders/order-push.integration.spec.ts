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
  PlanTemplatesService,
  PushNotifier,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
  type PushSender,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from './cart.service';
import { OrdersService } from './orders.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The reachability proof: a real order reaches a real handset.
 *
 * Everything else about push can be asserted in isolation — the Expo client
 * against a stubbed fetch, the notifier against real rows — and all of it would
 * still pass with nothing calling any of it. That is precisely what happened
 * the first time: `push_devices` shipped in 0015 with a registration endpoint
 * the customer app used, and `listActive` had no callers anywhere in the repo
 * for the whole of its life.
 *
 * So this spec does not test push. It tests that placing an order through
 * `OrdersService.confirmPayment` and `activateFinancing` — the two moments an
 * order becomes the seller's to pack — puts a message on the merchant's phone.
 * If the wiring were removed, this is the file that would fail.
 */
describe.skipIf(!RUN_DB)('a placed order notifies the merchant (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const applications = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const templates = new PlanTemplatesService(db, audit);
  const cart = new CartService(db);
  const devices = new DevicesService(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /** Captures what the transport was asked to deliver. */
  const delivered: { to: string; title: string; body: string; data?: Record<string, unknown> }[] =
    [];
  const sender: PushSender = {
    send: async (message) => {
      delivered.push(message);
      return { status: 'sent', id: `ticket-${delivered.length}`, rawResponse: {} };
    },
  };

  // The real notifier and the real devices table — only the wire is a stub.
  const orders = new OrdersService(
    db,
    inventory,
    applications,
    plans,
    ledger,
    audit,
    undefined,
    new PushNotifier(db, devices, sender),
  );

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(): Promise<string> {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Kwesi',
        last_name: 'Appiah',
        email: `push+${id}@example.gh`,
        phone: `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  async function shopWithHandset(handsets = 1) {
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

    const tokens: string[] = [];
    for (let i = 0; i < handsets; i++) {
      const t = `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;
      tokens.push(t);
      await devices.register({ merchantId: merchant.id }, { expo_token: t, platform: 'android' });
    }
    return { merchantId: merchant.id, storeId: store.id, tokens };
  }

  async function variant(storeId: string, price: number, title = 'Ankara Wrap Dress') {
    const product = await products.create(
      {
        store_id: storeId,
        title,
        base_price_pesewas: price,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 100 },
        ],
      },
      ACTOR,
    );
    return product.variants[0]!.id;
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

  // ------------------------------------------------------------ paid in full

  it('reaches the merchant’s phone when an order is paid', async () => {
    delivered.length = 0;
    const customerId = await freshCustomer();
    const { merchantId, storeId, tokens } = await shopWithHandset();
    const v = await variant(storeId, 32_000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    // Nothing yet: an unpaid order is not the seller's to pack.
    expect(delivered).toHaveLength(0);

    await orders.confirmPayment(order!.id, { provider_reference: 'ps_push_1' }, ACTOR);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe(tokens[0]);
    expect(delivered[0]?.title).toBe('New order to confirm');
    expect(delivered[0]?.body).toContain('Ankara Wrap Dress');
    // Integer pesewas formatted once, at the edge.
    expect(delivered[0]?.body).toContain('GHS 320.00');
    expect(delivered[0]?.data).toMatchObject({ kind: 'order_placed', orderId: order!.id });

    const rows = await pushRows(merchantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');
  });

  it('reaches every handset the merchant has registered', async () => {
    delivered.length = 0;
    const customerId = await freshCustomer();
    const { storeId, tokens } = await shopWithHandset(2);
    const v = await variant(storeId, 10_000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    await orders.confirmPayment(order!.id, { provider_reference: 'ps_push_2' }, ACTOR);

    expect(delivered.map((d) => d.to).sort()).toEqual([...tokens].sort());
  });

  it('summarises a multi-item order rather than naming only the first', async () => {
    delivered.length = 0;
    const customerId = await freshCustomer();
    const { storeId } = await shopWithHandset();
    const a = await variant(storeId, 10_000, 'Kente Trim Blazer');
    const b = await variant(storeId, 5_000, 'Adinkra Headwrap');
    await cart.addItem(customerId, { variant_id: a, quantity: 1 });
    await cart.addItem(customerId, { variant_id: b, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    await orders.confirmPayment(order!.id, { provider_reference: 'ps_push_3' }, ACTOR);

    expect(delivered[0]?.body).toMatch(/and 1 more item/);
  });

  // ----------------------------------------------------------------- the BNPL half

  it('reaches the phone when an instalment plan goes live, not when the order is raised', async () => {
    delivered.length = 0;
    const customerId = await freshCustomer();
    const { storeId } = await shopWithHandset();
    const v = await variant(storeId, 40_000);
    const template = (
      await templates.create(
        {
          name: `BNPL ${randomUUID()}`,
          business_model: 'bnpl',
          number_of_installments: 4,
          installment_frequency_days: 7,
          min_amount_pesewas: 1_000,
          max_amount_pesewas: 10_000_000,
        },
        ACTOR,
      )
    ).id;
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });

    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: template },
      ACTOR,
    );
    // `pending_approval` is with the credit engine, not the seller.
    expect(delivered).toHaveLength(0);

    // Underwriting approves it (engine side), the same call the existing orders
    // spec makes.
    await applications.recordDecision(order!.application_id!, { outcome: 'approved' }, ACTOR);
    await orders.activateFinancing(order!.id, ACTOR);

    // The customer has paid a deposit at most, and the seller still has to pack
    // it — which is the whole reason a merchant is paid at approval here.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.data).toMatchObject({ orderId: order!.id });
  });

  // ------------------------------------------------------------- degradation

  it('places the order anyway when the merchant has no handset', async () => {
    delivered.length = 0;
    const customerId = await freshCustomer();
    const { merchantId, storeId } = await shopWithHandset(0);
    const v = await variant(storeId, 8_000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    const paid = await orders.confirmPayment(order!.id, { provider_reference: 'ps_push_4' }, ACTOR);

    expect(paid.status).toBe('paid');
    expect(delivered).toHaveLength(0);
    expect(await pushRows(merchantId)).toHaveLength(0);
  });

  it('places the order anyway when the push transport is down', async () => {
    // The order is paid for. A provider outage must not turn that into an
    // error the customer sees, so the announcement is after the commit and
    // swallowed.
    const customerId = await freshCustomer();
    const { storeId } = await shopWithHandset();
    const v = await variant(storeId, 8_000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    const exploding = new OrdersService(
      db,
      inventory,
      applications,
      plans,
      ledger,
      audit,
      undefined,
      {
        notifyMerchantOfOrder: () => Promise.reject(new Error('Expo unreachable')),
      },
    );

    const paid = await exploding.confirmPayment(
      order!.id,
      { provider_reference: 'ps_push_5' },
      ACTOR,
    );

    expect(paid.status).toBe('paid');
  });
});
