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
  PLATFORM_ACCOUNT_REF,
  PlanTemplatesService,
  SYSTEM_ACTORS,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { AddressesService } from './addresses.service';
import { CartService } from './cart.service';
import { OrdersService } from './orders.service';
import { OrderPaymentService } from './order-payment.service';
import {
  EmptyCartError,
  OrderNotActivatableError,
  OrderNotCancellableError,
  OrderNotFoundError,
  OrderNotPayableError,
} from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('OrdersService (integration)', () => {
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
  const addresses = new AddressesService(db);
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

  /**
   * Checkout reserves stock; nothing ever gave it back. InventoryService.release
   * was written for this ("cancel / expiry") and had no caller, so an order the
   * customer abandoned held its units out of sellable stock forever.
   */
  it('cancel returns the reserved stock to available', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 2000);
    await cart.addItem(customerId, { variant_id: v, quantity: 3 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    const reserved = await inventory.getByVariant(v);
    expect(reserved.quantity_available).toBe(97);
    expect(reserved.quantity_reserved).toBe(3);

    const cancelled = await orders.cancel(order!.id, { reason: 'Changed my mind' }, ACTOR);
    expect(cancelled.status).toBe('cancelled');

    // Back to where it started — released, not sold.
    const after = await inventory.getByVariant(v);
    expect(after.quantity_available).toBe(100);
    expect(after.quantity_reserved).toBe(0);

    // A second cancel is refused rather than releasing the same units twice.
    await expect(orders.cancel(order!.id, {}, ACTOR)).rejects.toBeInstanceOf(
      OrderNotCancellableError,
    );
  });

  it('refuses to cancel an order that has already been paid', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 2000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    await orders.confirmPayment(order!.id, { provider_reference: 'ps_ref_cancel' }, ACTOR);

    // ORDER_TRANSITIONS permits paid -> cancelled, but that needs the ledger
    // reversed and the customer refunded. Cancelling here would keep the cash.
    await expect(orders.cancel(order!.id, {}, ACTOR)).rejects.toBeInstanceOf(
      OrderNotCancellableError,
    );

    // Nothing moved: the sale stands and the stock stays sold.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_available).toBe(99);
    expect(inv.quantity_reserved).toBe(0);
  });

  it('scopes a cancel to the order owner', async () => {
    const owner = await freshCustomer();
    const stranger = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 2000);
    await cart.addItem(owner, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(owner, { payment_type: 'full' }, ACTOR);

    // Not found rather than forbidden — a stranger must not learn it exists.
    await expect(
      orders.cancel(order!.id, {}, ACTOR, { customerId: stranger }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    // And the units are still held for the real owner.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_reserved).toBe(1);
  });

  /**
   * The sweep is what actually closes abandonment: `cancel` only helps when
   * somebody asks, and the shopper who never paid is by definition not coming
   * back to tidy up.
   */
  /**
   * Customer-initiated payment. Orders deliberately do not use payment_attempts
   * (see order-payment.service), so the provider reference lives on the order
   * and is the only thing tying an asynchronous charge.success back to it.
   */
  describe('customer MoMo payment', () => {
    function stubPaystack(status: string) {
      const calls: { reference: string; amount: number }[] = [];
      const client = {
        chargeMobileMoney: async (req: { reference: string; amount: number }) => {
          calls.push({ reference: req.reference, amount: req.amount });
          return { data: { reference: req.reference, status, display_text: 'Approve it' } };
        },
      };
      return { client, calls };
    }

    async function payableOrder(qty = 2) {
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 2000);
      await cart.addItem(customerId, { variant_id: v, quantity: qty });
      const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
      return { customerId, variantId: v, order: order! };
    }

    it('settles the order when the provider approves synchronously', async () => {
      const { customerId, variantId, order } = await payableOrder();
      const { client, calls } = stubPaystack('success');
      const payments = new OrderPaymentService(db, orders, client);

      const result = await payments.payWithMobileMoney(
        { orderId: order.id, customerId, email: 'a@b.com', phone: '0245550000', provider: 'mtn' },
        ACTOR,
      );

      expect(result.status).toBe('paid');
      // The amount charged is the order total, in pesewas.
      expect(calls[0]!.amount).toBe(order.total_pesewas);
      expect(result.reference).toBe(OrderPaymentService.referenceFor(order.id));

      const inv = await inventory.getByVariant(variantId);
      expect(inv.quantity_reserved).toBe(0);
    });

    it('leaves the order unpaid but records the reference when the charge is pending', async () => {
      const { customerId, variantId, order } = await payableOrder();
      const { client } = stubPaystack('pay_offline');
      const payments = new OrderPaymentService(db, orders, client);

      const result = await payments.payWithMobileMoney(
        { orderId: order.id, customerId, email: 'a@b.com', phone: '0245550000', provider: 'mtn' },
        ACTOR,
      );
      expect(result.status).toBe('pending');

      // Nothing has been paid, and the units are still held for the customer.
      const inv = await inventory.getByVariant(variantId);
      expect(inv.quantity_reserved).toBe(2);

      // The webhook can now find it — which is the whole point of the reference.
      const found = await payments.findByPaymentReference(result.reference);
      expect(found?.id).toBe(order.id);
    });

    it('settleByPaymentReference is what turns a later charge.success into a paid order', async () => {
      const { customerId, variantId, order } = await payableOrder();
      const { client } = stubPaystack('pay_offline');
      const payments = new OrderPaymentService(db, orders, client);
      const { reference } = await payments.payWithMobileMoney(
        { orderId: order.id, customerId, email: 'a@b.com', phone: '0245550000', provider: 'mtn' },
        ACTOR,
      );

      expect(await payments.settleByPaymentReference(reference, ACTOR)).toBe(true);

      const inv = await inventory.getByVariant(variantId);
      expect(inv.quantity_reserved).toBe(0);

      // A re-delivered webhook must not book the money twice. It still claims
      // the reference so the caller does not alert on something we know.
      expect(await payments.settleByPaymentReference(reference, ACTOR)).toBe(true);
      const after = await inventory.getByVariant(variantId);
      expect(after.quantity_reserved).toBe(0);
    });

    it('returns false for a reference that is not an order, so the webhook still alerts', async () => {
      const { client } = stubPaystack('success');
      const payments = new OrderPaymentService(db, orders, client);
      expect(await payments.settleByPaymentReference('NOT-AN-ORDER-REF', ACTOR)).toBe(false);
    });

    it('refuses to charge an order that is not awaiting payment', async () => {
      const { customerId, order } = await payableOrder(1);
      const { client } = stubPaystack('success');
      const payments = new OrderPaymentService(db, orders, client);
      await orders.confirmPayment(order.id, { provider_reference: 'already' }, ACTOR);

      await expect(
        payments.payWithMobileMoney(
          { orderId: order.id, customerId, email: 'a@b.com', phone: '0245550000', provider: 'mtn' },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(OrderNotPayableError);
    });
  });

  it('declineFinancing closes the order and gives the stock back', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 50_000);
    const templateId = await bnplTemplate();
    await cart.addItem(customerId, { variant_id: v, quantity: 2 });
    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );
    expect(order!.status).toBe('pending_approval');

    const declined = await orders.declineFinancing(order!.id, ACTOR);
    expect(declined.status).toBe('declined');

    // The units were being held for financing that is not going to happen.
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_available).toBe(100);
    expect(inv.quantity_reserved).toBe(0);

    // Idempotent: a retried decision must not release the same units twice.
    const again = await orders.declineFinancing(order!.id, ACTOR);
    expect(again.status).toBe('declined');
    const after = await inventory.getByVariant(v);
    expect(after.quantity_available).toBe(100);
    expect(after.quantity_reserved).toBe(0);
  });

  it('refuses to decline an order that is not awaiting a credit decision', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 2000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    // A pay-in-full order has no credit decision to decline.
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    await expect(orders.declineFinancing(order!.id, ACTOR)).rejects.toBeInstanceOf(
      OrderNotCancellableError,
    );
    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_reserved).toBe(1);
  });

  it('sweeps unpaid orders past the TTL and leaves fresh ones alone', async () => {
    const { storeId } = await merchantWithStore();

    const stale = await freshCustomer();
    const staleVariant = await variant(storeId, 2000);
    await cart.addItem(stale, { variant_id: staleVariant, quantity: 4 });
    const [staleOrder] = await orders.checkout(stale, { payment_type: 'full' }, ACTOR);

    const fresh = await freshCustomer();
    const freshVariant = await variant(storeId, 2000);
    await cart.addItem(fresh, { variant_id: freshVariant, quantity: 2 });
    await orders.checkout(fresh, { payment_type: 'full' }, ACTOR);

    // Backdate only the first order. Both were created in the same instant, so
    // without this a cutoff far enough in the future catches them both and the
    // test proves nothing about the boundary.
    await db
      .update(schema.orders)
      .set({ created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() })
      .where(eq(schema.orders.id, staleOrder!.id));

    const summary = await orders.sweepAbandoned(new Date(), { paymentTtlHours: 24 });
    expect(summary.cancelled).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    // The backdated order is cancelled and its four units are back.
    const staleInv = await inventory.getByVariant(staleVariant);
    expect(staleInv.quantity_available).toBe(100);
    expect(staleInv.quantity_reserved).toBe(0);

    // The one still inside its window is untouched, units still held.
    const freshInv = await inventory.getByVariant(freshVariant);
    expect(freshInv.quantity_available).toBe(98);
    expect(freshInv.quantity_reserved).toBe(2);

    // Sweeping again has nothing left to do — it does not re-release.
    const second = await orders.sweepAbandoned(new Date(), { paymentTtlHours: 24 });
    expect(second.checked).toBe(0);
  });

  it('sweeps an order whose credit application went terminal', async () => {
    const customerId = await freshCustomer();
    const { storeId } = await merchantWithStore();
    const v = await variant(storeId, 50_000);
    const templateId = await bnplTemplate();
    await cart.addItem(customerId, { variant_id: v, quantity: 3 });
    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );
    expect(order!.status).toBe('pending_approval');

    // ApplicationExpiryCron expires stale applications, and an admin can decline
    // one, but neither touches the order — it would hold its stock forever with
    // nothing left that could approve it.
    await applications.cancel(order!.application_id!, ACTOR);

    const summary = await orders.sweepAbandoned(new Date(), { paymentTtlHours: 24 });
    expect(summary.cancelled).toBeGreaterThanOrEqual(1);

    const inv = await inventory.getByVariant(v);
    expect(inv.quantity_available).toBe(100);
    expect(inv.quantity_reserved).toBe(0);
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

  describe('delivery pricing at checkout', () => {
    it('charges nothing when the checkout names no destination', async () => {
      // `shipping_address_id` has always been optional, and without one the
      // delivery-zone lookup falls through to the national rate. Charging that
      // would bill the customer for a delivery nobody can make.
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 1500);
      await cart.addItem(customerId, { variant_id: v, quantity: 1 });

      const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

      expect(order!.shipping_pesewas).toBe(0);
      expect(order!.total_pesewas).toBe(order!.subtotal_pesewas);
      expect(order!.shipping_address_id).toBeNull();
    });

    it('charges the zone rate once there is an address to deliver to', async () => {
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 1500);
      await cart.addItem(customerId, { variant_id: v, quantity: 1 });

      // The harness truncates delivery_zones, so the migration's seeded rates
      // are gone by the time a spec runs — the zone under test is explicit.
      await db.insert(schema.delivery_zones).values({
        region: 'Greater Accra',
        city: 'Accra',
        fee_pesewas: 1500,
        eta_min_days: 1,
        eta_max_days: 3,
      });

      const address = await addresses.create(customerId, {
        recipient: 'Ama Boateng',
        phone: '0240000002',
        region: 'Greater Accra',
        city: 'Accra',
      });

      const [order] = await orders.checkout(
        customerId,
        { payment_type: 'full', shipping_address_id: address.id, fulfilment_method: 'courier' },
        ACTOR,
      );

      // The seeded Greater Accra / Accra zone: GHS 15.
      expect(order!.shipping_pesewas).toBe(1500);
      expect(order!.total_pesewas).toBe(order!.subtotal_pesewas + 1500);
      expect(order!.fulfilment_method).toBe('courier');
    });

    it('charges nothing for collection, and records the hub', async () => {
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 1500);
      await cart.addItem(customerId, { variant_id: v, quantity: 1 });

      const hub = (
        await db
          .insert(schema.pickup_hubs)
          .values({ name: 'Circle Hub', region: 'Greater Accra', city: 'Accra' })
          .returning()
      )[0]!;

      const [order] = await orders.checkout(
        customerId,
        { payment_type: 'full', fulfilment_method: 'pickup', pickup_hub_id: hub.id },
        ACTOR,
      );

      expect(order!.shipping_pesewas).toBe(0);
      expect(order!.fulfilment_method).toBe('pickup');
      expect(order!.pickup_hub_id).toBe(hub.id);
    });

    it('refuses collection without a hub, rather than picking one', async () => {
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 1500);
      await cart.addItem(customerId, { variant_id: v, quantity: 1 });

      await expect(
        orders.checkout(customerId, { payment_type: 'full', fulfilment_method: 'pickup' }, ACTOR),
      ).rejects.toThrow(/pickup_hub_id/);
    });

    it('records a customer-readable event when the order is created', async () => {
      const customerId = await freshCustomer();
      const { storeId } = await merchantWithStore();
      const v = await variant(storeId, 1500);
      await cart.addItem(customerId, { variant_id: v, quantity: 1 });

      const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

      const events = await db
        .select()
        .from(schema.order_events)
        .where(eq(schema.order_events.order_id, order!.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('order.created');
      expect(events[0]!.label).toBe('Order placed');
    });
  });
});
