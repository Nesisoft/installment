import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  PayoutRecorder,
  PlanTemplatesService,
  RefundService,
  ReserveReleaseService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { FulfilmentService } from '../fulfilment/fulfilment.service';
import { CartService } from './cart.service';
import { OrdersService } from './orders.service';
import { OrderNotFoundError } from './errors';
import { MerchantOrdersService } from './merchant-orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { ReturnsService } from '../returns/returns.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The console's orders: every seller's, findable, and openable.
 *
 * Driven through the real checkout, payment, financing and return paths, as
 * the seller's queue is, so the projection is checked against the writers
 * rather than against hand-inserted rows.
 */
describe.skipIf(!RUN_DB)('AdminOrdersService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const applications = new ApplicationsService(db, audit);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves);
  const templates = new PlanTemplatesService(db, audit);
  const cart = new CartService(db);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const refunds = new RefundService(db, ledger, audit);
  const returns = new ReturnsService(db, ledger, audit, inventory, refunds);
  const admin = new AdminOrdersService(db, new MerchantOrdersService(db));
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(first = 'Akosua', last = 'Owusu') {
    const id = randomUUID();
    const phone = `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`;
    const email = `admin-orders+${id}@example.gh`;
    const [row] = await db
      .insert(schema.customers)
      .values({ first_name: first, last_name: last, email, phone })
      .returning({ id: schema.customers.id });
    return { id: row!.id, phone, email };
  }

  async function shop(name: string) {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `${name} ${id}`,
        legal_name: `${name} Ltd ${id}`,
        email: `shop+${id}@example.gh`,
        phone: '+233244555555',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `s-${id.slice(0, 8)}`, display_name: `${name} store` },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id, name: merchant.business_name };
  }

  async function variant(storeId: string, price: number) {
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Kente Stole',
        base_price_pesewas: price,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 500 },
        ],
      },
      ACTOR,
    );
    return product.variants[0]!;
  }

  async function unpaid(storeId: string, price: number, quantity = 1, customer?: { id: string }) {
    const buyer = customer ?? (await freshCustomer());
    const v = await variant(storeId, price);
    await cart.addItem(buyer.id, { variant_id: v.id, quantity });
    const [order] = await orders.checkout(buyer.id, { payment_type: 'full' }, ACTOR);
    return order!;
  }

  async function financed(storeId: string, price: number) {
    const buyer = await freshCustomer();
    const v = await variant(storeId, price);
    const template = await templates.create(
      {
        name: `BNPL ${randomUUID()}`,
        business_model: 'bnpl',
        down_payment_bps: 4_000,
        number_of_installments: 3,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      ACTOR,
    );
    await cart.addItem(buyer.id, { variant_id: v.id, quantity: 1 });
    const [order] = await orders.checkout(
      buyer.id,
      { payment_type: 'installment', plan_template_id: template.id },
      ACTOR,
    );
    await applications.recordDecision(order!.application_id!, { outcome: 'approved' }, ACTOR);
    return orders.activateFinancing(order!.id, ACTOR);
  }

  it("lists every seller's orders, with who each one is between", async () => {
    const a = await shop('Adwoa Fabrics');
    const b = await shop('Kwame Electronics');
    const buyer = await freshCustomer('Esi', 'Mensah');
    const first = await unpaid(a.storeId, 12_000, 3, buyer);
    const second = await financed(b.storeId, 50_000);

    const { rows } = await admin.list({ limit: 200 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first.id)).toMatchObject({
      status: 'pending_payment',
      item_count: 3,
      customer_name: 'Esi Mensah',
      merchant_name: a.name,
      store_name: 'Adwoa Fabrics store',
    });
    expect(byId.get(second.id)).toMatchObject({
      status: 'financing_active',
      payment_type: 'installment',
      merchant_name: b.name,
    });
  });

  it('narrows by status, by payment type, and by order number or id', async () => {
    const { storeId } = await shop('Filter');
    const open = await unpaid(storeId, 9_000);
    const plan = await financed(storeId, 40_000);

    const awaiting = (await admin.list({ status: 'pending_payment', limit: 200 })).rows;
    expect(awaiting.map((r) => r.id)).toContain(open.id);
    expect(awaiting.every((r) => r.status === 'pending_payment')).toBe(true);

    const instalment = (await admin.list({ payment_type: 'installment', limit: 200 })).rows;
    expect(instalment.map((r) => r.id)).toContain(plan.id);
    expect(instalment.map((r) => r.id)).not.toContain(open.id);

    const part = open.order_number.slice(-6);
    expect((await admin.list({ q: part })).rows.map((r) => r.id)).toContain(open.id);
    expect((await admin.list({ q: open.id })).rows.map((r) => r.id)).toEqual([open.id]);
    // A search is a search, not a pattern: "%" matches only a literal percent.
    expect((await admin.list({ q: '%' })).rows).toEqual([]);
  });

  it('counts orders by status', async () => {
    const before = await admin.counts();
    const { storeId } = await shop('Count');
    await unpaid(storeId, 5_000);
    await unpaid(storeId, 5_000);
    const after = await admin.counts();
    expect(after.pending_payment - before.pending_payment).toBe(2);
    expect(after.all - before.all).toBe(2);
  });

  it('opens an order with the buyer, the seller, and its returns and refunds', async () => {
    const { merchantId, storeId, name } = await shop('Detail');
    const buyer = await freshCustomer('Yaw', 'Boateng');
    const order = await unpaid(storeId, 32_000, 1, buyer);
    await orders.confirmPayment(order.id, { provider_reference: 'BANK-TRF-77' }, ACTOR);
    const asked = await returns.request(buyer.id, order.id, { reason: 'Wrong colour' });
    await returns.approve(asked.id, ACTOR, { merchantId });

    const detail = await admin.detail(order.id);

    expect(detail.customer).toEqual({
      id: buyer.id,
      name: 'Yaw Boateng',
      phone: buyer.phone,
      email: buyer.email,
    });
    expect(detail.merchant).toEqual({ id: merchantId, business_name: name });
    expect(detail.store?.display_name).toBe('Detail store');
    // The seller's sheet, as they see it.
    expect(detail.items).toHaveLength(1);
    expect(detail.settlement).toBeDefined();
    expect(detail.events.length).toBeGreaterThan(0);
    // The return, and the refund it raised.
    expect(detail.returns).toHaveLength(1);
    expect(detail.returns[0]).toMatchObject({
      id: asked.id,
      status: 'approved',
      reason: 'Wrong colour',
      refund: { status: 'initiated', amount_pesewas: asked.refund_amount_pesewas },
    });
  });

  it('refunds a return by hand when the payment came in outside Paystack', async () => {
    // A bank transfer's reference is not a Paystack charge: sending a refund
    // against it is refused, or lands on somebody else's charge.
    const { merchantId, storeId } = await shop('Transfer');
    const buyer = await freshCustomer();
    const byTransfer = await unpaid(storeId, 20_000, 1, buyer);
    await orders.confirmPayment(
      byTransfer.id,
      { provider_reference: 'GCB TRF 7781', paid_via: 'outside_paystack' },
      ACTOR,
    );
    const cash = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `order-payment:${byTransfer.id}`));
    expect(cash.find((e) => e.account_type === 'paystack_settlement')?.account_ref).toBe('manual');

    const asked = await returns.request(buyer.id, byTransfer.id, { reason: 'Changed my mind' });
    await returns.approve(asked.id, ACTOR, { merchantId });
    const [refund] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.order_return_id, asked.id));
    expect(refund).toMatchObject({ method: 'manual', provider_transaction_reference: null });

    // Through Paystack — the default, and what the webhook settles — it still
    // goes back through the charge.
    const byCharge = await unpaid(storeId, 20_000, 1, buyer);
    await orders.confirmPayment(byCharge.id, { provider_reference: 'ps_ref_123' }, ACTOR);
    const again = await returns.request(buyer.id, byCharge.id, { reason: 'Too small' });
    await returns.approve(again.id, ACTOR, { merchantId });
    const [viaPaystack] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.order_return_id, again.id));
    expect(viaPaystack).toMatchObject({
      method: 'paystack',
      provider_transaction_reference: 'ps_ref_123',
    });
  });

  it('answers an unknown id, or one that is not an id at all, as not found', async () => {
    await expect(admin.detail(randomUUID())).rejects.toBeInstanceOf(OrderNotFoundError);
    await expect(admin.detail('counts')).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});
