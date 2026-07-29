import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  PLATFORM_ACCOUNT_REF,
  PlanTemplatesService,
  SYSTEM_ACTORS,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from './cart.service';
import { OrdersService } from './orders.service';
import { EmptyCartError, OrderNotActivatableError, OrderNotPayableError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('OrdersService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
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
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

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
        email: `ord+${id}@example.gh`,
        phone: `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  async function merchantWithStore(): Promise<{ merchantId: string; storeId: string }> {
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
    return { merchantId: merchant.id, storeId: store.id };
  }

  async function variant(storeId: string, price: number): Promise<string> {
    const product = await products.create(
      {
        store_id: storeId,
        title: `P ${randomUUID().slice(0, 8)}`,
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

  async function bnplTemplate(): Promise<string> {
    const tmpl = await templates.create(
      {
        name: `BNPL ${randomUUID()}`,
        business_model: 'bnpl',
        number_of_installments: 4,
        installment_frequency_days: 7,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 10_000_000,
      },
      ACTOR,
    );
    return tmpl.id;
  }

  it('checks out a full cart: one pending_payment order, reserves stock, converts the cart', async () => {
    const customerId = await freshCustomer();
    const { merchantId, storeId } = await merchantWithStore();
    const v = await variant(storeId, 1500);
    await cart.addItem(customerId, { variant_id: v, quantity: 2 });

    const created = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    expect(created).toHaveLength(1);
    const order = created[0]!;
    expect(order.merchant_id).toBe(merchantId);
    expect(order.payment_type).toBe('full');
    expect(order.status).toBe('pending_payment');
    expect(order.subtotal_pesewas).toBe(3000);
    expect(order.total_pesewas).toBe(3000);
    expect(order.commission_bps).toBe(500);
    expect(order.application_id).toBeNull();
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.line_total_pesewas).toBe(3000);
    expect(order.items[0]!.sku).toMatch(/^SKU-/);

    // Stock reserved, not yet committed.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_available).toBe(98);
    expect(inv.quantity_reserved).toBe(2);

    // Cart was converted — a fresh active cart is now empty.
    const fresh = await cart.getCart(customerId);
    expect(fresh.items).toHaveLength(0);
    expect(fresh.id).not.toBe(order.id);
  });

  it('confirmPayment books the marketplace commission split and commits stock', async () => {
    const customerId = await freshCustomer();
    const { merchantId, storeId } = await merchantWithStore();
    const v = await variant(storeId, 2000);
    await cart.addItem(customerId, { variant_id: v, quantity: 3 }); // total 6000
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    const revenueBefore = await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF);

    const paid = await orders.confirmPayment(order!.id, { provider_reference: 'ps_ref_1' }, ACTOR);
    expect(paid.status).toBe('paid');
    expect(paid.placed_at).not.toBeNull();

    // 6000 @ 5% → commission 300, merchant net 5700.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(5700);
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(revenueBefore + 300);

    // Reservation committed: reserved back to 0, available NOT returned.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_available).toBe(97);
    expect(inv.quantity_reserved).toBe(0);

    // Idempotent: a second confirm is rejected (already paid).
    await expect(
      orders.confirmPayment(order!.id, { provider_reference: 'ps_ref_1' }, ACTOR),
    ).rejects.toBeInstanceOf(OrderNotPayableError);
  });

  it('checks out an installment cart: hands the order to the engine as an application', async () => {
    const customerId = await freshCustomer();
    const { merchantId, storeId } = await merchantWithStore();
    const v = await variant(storeId, 50_000);
    const templateId = await bnplTemplate();
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });

    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );
    expect(order!.payment_type).toBe('installment');
    expect(order!.status).toBe('pending_approval');
    expect(order!.commission_bps).toBe(0);
    expect(order!.application_id).not.toBeNull();

    const application = await applications.get(order!.application_id!);
    expect(application.order_reference).toBe(order!.id); // the seam
    expect(application.order_amount_pesewas).toBe(50_000);
    expect(application.merchant_id).toBe(merchantId);
    expect(application.status).toBe('pending');
  });

  it('activateFinancing turns an approved application into an active plan', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 80_000);
    const templateId = await bnplTemplate();
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );

    // Underwriting approves the application (engine side).
    await applications.recordDecision(order!.application_id!, { outcome: 'approved' }, ACTOR);

    const activated = await orders.activateFinancing(order!.id, ACTOR);
    expect(activated.status).toBe('financing_active');
    expect(activated.customer_plan_id).not.toBeNull();

    const plan = await plans.get(activated.customer_plan_id!);
    expect(plan.status).toBe('active');
    expect(plan.order_amount_pesewas).toBe(80_000);

    // Reservation committed on activation.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_reserved).toBe(0);

    // Idempotent: activating again just returns the active order.
    const again = await orders.activateFinancing(order!.id, ACTOR);
    expect(again.status).toBe('financing_active');
    expect(again.customer_plan_id).toBe(activated.customer_plan_id);
  });

  it('cannot activate financing before the application is approved', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 40_000);
    const templateId = await bnplTemplate();
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );
    await expect(orders.activateFinancing(order!.id, ACTOR)).rejects.toBeInstanceOf(
      OrderNotActivatableError,
    );
  });

  it('splits a multi-vendor cart into one order per merchant', async () => {
    const customerId = await freshCustomer();
    const a = await merchantWithStore();
    const b = await merchantWithStore();
    const va = await variant(a.storeId, 1000);
    const vb = await variant(b.storeId, 2500);
    await cart.addItem(customerId, { variant_id: va, quantity: 1 });
    await cart.addItem(customerId, { variant_id: vb, quantity: 2 });

    const created = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    expect(created).toHaveLength(2);
    const byMerchant = new Map(created.map((ord) => [ord.merchant_id, ord]));
    expect(byMerchant.get(a.merchantId)!.total_pesewas).toBe(1000);
    expect(byMerchant.get(b.merchantId)!.total_pesewas).toBe(5000);
  });

  it('rejects checkout of an empty cart', async () => {
    const customerId = await freshCustomer();
    await expect(
      orders.checkout(customerId, { payment_type: 'full' }, ACTOR),
    ).rejects.toBeInstanceOf(EmptyCartError);
  });
});
