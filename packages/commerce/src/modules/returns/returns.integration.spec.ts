import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  PayoutRecorder,
  PlanTemplatesService,
  PLATFORM_ACCOUNT_REF,
  RefundService,
  ReserveReleaseService,
  SETTLEMENT_CASH_REF,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService, orderPaymentTransactionId } from '../orders/orders.service';
import { FulfilmentService } from '../fulfilment/fulfilment.service';
import { ReturnsService } from './returns.service';
import {
  OrderNotReturnableError,
  ReturnAlreadyDecidedError,
  ReturnAlreadyOpenError,
  ReturnWindowClosedError,
} from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Returns, end to end, against Postgres.
 *
 * `orders.status` has permitted `'returned'` since 0006 and nothing had ever
 * written it. Underneath that, the refund engine could not have paid anybody
 * back for an outright purchase: `refunds.customer_plan_id` and `schedule_id`
 * were both NOT NULL, so every row was a refund of one instalment on one credit
 * plan and a pay-in-full order had neither.
 *
 * So this spec is not about a status column. Every test drives a real checkout
 * and a real payment, then asks for a return through `ReturnsService` with the
 * real `RefundService`, `LedgerService` and `InventoryService` behind it. The
 * assertions worth having are the ones about money and stock: that the sale is
 * reversed, that the buyer is owed exactly what they paid, that the goods go
 * back on sale, and that the ledger still balances afterwards.
 */
describe.skipIf(!RUN_DB)('ReturnsService (integration)', () => {
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
  const refunds = new RefundService(db, ledger, audit);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const returns = new ReturnsService(db, ledger, audit, inventory, refunds);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function shopper(): Promise<string> {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Boateng',
        email: `ret-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
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

  /** A paid, outright order for `price`, with `stock` units listed. */
  async function paidOrder(price = 32_000, stock = 10) {
    const customerId = await shopper();
    const { merchantId, storeId } = await shop();
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Ankara Wrap Dress',
        base_price_pesewas: price,
        status: 'active',
        variants: [
          {
            sku: `SKU-${randomUUID().slice(0, 8)}`,
            price_pesewas: null,
            quantity_available: stock,
          },
        ],
      },
      ACTOR,
    );
    const variantId = product.variants[0]!.id;
    await cart.addItem(customerId, { variant_id: variantId, quantity: 1 });
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      raised!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    return { order: paid, customerId, merchantId, variantId, price };
  }

  /**
   * A GHS 50 sale with GHS 15 delivery, paid. `oldRule` books the payment the
   * way it was booked before commission moved off delivery — 5% of the whole
   * 6500 — which is what every order paid until then carries in the ledger.
   */
  async function paidOrderWithDelivery(opts: { oldRule?: boolean } = {}) {
    const customerId = await shopper();
    const { merchantId, storeId } = await shop();
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Kente Stole',
        base_price_pesewas: 5_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 5 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    await db
      .update(schema.orders)
      .set({ shipping_pesewas: 1_500, total_pesewas: 6_500 })
      .where(eq(schema.orders.id, raised!.id));

    if (!opts.oldRule) {
      const paid = await orders.confirmPayment(
        raised!.id,
        { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
        ACTOR,
      );
      return { order: paid, customerId, merchantId };
    }

    const transactionId = orderPaymentTransactionId(raised!.id);
    await ledger.record([
      {
        transactionId,
        accountType: 'paystack_settlement',
        accountRef: SETTLEMENT_CASH_REF,
        direction: 'debit',
        amountPesewas: 6_500,
        description: 'old-rule payment',
      },
      {
        transactionId,
        accountType: 'merchant_payable',
        accountRef: merchantId,
        direction: 'credit',
        amountPesewas: 6_175,
        description: 'old-rule payment',
      },
      {
        transactionId,
        accountType: 'revenue',
        accountRef: PLATFORM_ACCOUNT_REF,
        direction: 'credit',
        amountPesewas: 325,
        description: 'old-rule payment',
      },
    ]);
    const [order] = await db
      .update(schema.orders)
      .set({ status: 'paid', placed_at: new Date().toISOString() })
      .where(eq(schema.orders.id, raised!.id))
      .returning();
    return { order: order!, customerId, merchantId };
  }

  const stockOf = async (variantId: string) =>
    (await inventory.getByVariant(variantId)).quantity_available;

  async function trialBalance(): Promise<number> {
    const rows = await db.select().from(schema.ledger_entries);
    return rows.reduce(
      (sum, r) =>
        sum + (r.direction === 'credit' ? Number(r.amount_pesewas) : -Number(r.amount_pesewas)),
      0,
    );
  }

  // ------------------------------------------------------------------ request

  it('records a return request against the order, without touching it', async () => {
    const { order, customerId } = await paidOrder();

    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    expect(request).toMatchObject({
      order_id: order.id,
      customer_id: customerId,
      status: 'requested',
      reason: 'Wrong size',
      // Fixed at request time from the order total, so the decision is about a
      // known amount.
      refund_amount_pesewas: order.total_pesewas,
    });
    expect(request.decided_at).toBeNull();
    // Asking is not returning: the order is still a paid sale until somebody
    // decides.
    const [still] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(still?.status).toBe('paid');
  });

  it('shows up on the buyer’s own order timeline', async () => {
    const { order, customerId } = await paidOrder();
    await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const events = await db
      .select()
      .from(schema.order_events)
      .where(
        and(
          eq(schema.order_events.order_id, order.id),
          eq(schema.order_events.event_type, 'order.return_requested'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.label).toBe('Return requested');
  });

  it('answers “not found” for somebody else’s order', async () => {
    // A 404, never a 403 — confirming the order exists is the leak.
    const { order } = await paidOrder();
    const stranger = await shopper();

    await expect(
      returns.request(stranger, order.id, { reason: 'Mine now' }),
    ).rejects.toBeInstanceOf(OrderNotReturnableError);
  });

  it('refuses a second request while one is waiting', async () => {
    const { order, customerId } = await paidOrder();
    await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await expect(
      returns.request(customerId, order.id, { reason: 'Asking again' }),
    ).rejects.toBeInstanceOf(ReturnAlreadyOpenError);
  });

  it('refuses an order nobody has paid for', async () => {
    const customerId = await shopper();
    const { storeId } = await shop();
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Kente Trim Blazer',
        base_price_pesewas: 10_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 5 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    await expect(
      returns.request(customerId, raised!.id, { reason: 'Changed my mind' }),
    ).rejects.toBeInstanceOf(OrderNotReturnableError);
  });

  it('refuses once the return window has closed', async () => {
    const { order, customerId } = await paidOrder();
    await fulfilment.markShipped(order.id, {}, ACTOR);
    await fulfilment.markDelivered(order.id, {}, ACTOR);
    // Wind the window back past today. `ReturnWindowCron` would have closed the
    // order to `completed`, and `completed -> returned` is not a legal
    // transition — this is the same boundary, checked before that sweep runs.
    await db
      .update(schema.orders)
      .set({ return_window_ends_at: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(schema.orders.id, order.id));

    await expect(
      returns.request(customerId, order.id, { reason: 'Too late' }),
    ).rejects.toBeInstanceOf(ReturnWindowClosedError);
  });

  it('refuses an instalment order, rather than half-unwinding a credit plan', async () => {
    // A financed order's money is already split across an accrual, a reserve
    // and a merchant payable, against a plan the customer is still paying.
    // That is a credit unwind, not a refund, and it is not this flow.
    const customerId = await shopper();
    const { storeId } = await shop();
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
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Fridge',
        base_price_pesewas: 200_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 3 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [raised] = await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: template },
      ACTOR,
    );
    await applications.recordDecision(raised!.application_id!, { outcome: 'approved' }, ACTOR);
    await orders.activateFinancing(raised!.id, ACTOR);

    await expect(
      returns.request(customerId, raised!.id, { reason: 'Does not fit the kitchen' }),
    ).rejects.toThrow(/credit plan/);
  });

  // ------------------------------------------------------------------ approve

  it('reverses the sale, restocks the goods and owes the buyer their money', async () => {
    const { order, customerId, merchantId, variantId, price } = await paidOrder(32_000, 10);
    // One unit sold, so nine are on the shelf.
    expect(await stockOf(variantId)).toBe(9);
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const approved = await returns.approve(request.id, ACTOR, { merchantId });

    expect(approved.status).toBe('approved');
    expect(approved.decided_at).not.toBeNull();

    // The order is no longer a sale — the first row ever to say so.
    const [returned] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(returned?.status).toBe('returned');

    // The goods are sellable again.
    expect(await stockOf(variantId)).toBe(10);

    // The merchant's credit is withdrawn: 5% commission on GHS 320.00 leaves
    // GHS 304.00, and that is exactly what comes back off their payable.
    const payableAfter = await ledger.balanceOf('merchant_payable', merchantId);
    expect(payableBefore - payableAfter).toBe(30_400);

    // And the buyer is owed the whole thing, under the return's own id so the
    // disbursement can discharge the same balance.
    expect(await ledger.balanceOf('refund_payable', request.id)).toBe(price);
  });

  it('reverses what the payment booked, delivery passed through to the seller', async () => {
    const { order, customerId, merchantId } = await paidOrderWithDelivery();
    // Commission on the goods only: 250 of the 6500, the seller credited 6250.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(6_250);
    const revenueBefore = await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF);
    const request = await returns.request(customerId, order.id, { reason: 'Wrong colour' });

    await returns.approve(request.id, ACTOR, { merchantId });

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(revenueBefore - 250);
    expect(await ledger.balanceOf('refund_payable', request.id)).toBe(6_500);
  });

  it('reverses an order paid under the old rule exactly as it was booked', async () => {
    // Paid when commission was taken on delivery too: 325 to revenue, 6175 to
    // the seller. Reversing it at today's rule would take 6250 back off a
    // seller credited 6175 and hand the platform 75 of revenue it kept.
    const { order, customerId, merchantId } = await paidOrderWithDelivery({ oldRule: true });
    const revenueBefore = await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF);
    const request = await returns.request(customerId, order.id, { reason: 'Wrong colour' });

    await returns.approve(request.id, ACTOR, { merchantId });

    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(0);
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(revenueBefore - 325);
    expect(await ledger.balanceOf('refund_payable', request.id)).toBe(6_500);
    expect(await trialBalance()).toBe(0);
  });

  it('leaves the books balanced', async () => {
    // The property that matters more than any single figure: the reversal is
    // three entries whose debits equal its credit by construction.
    const { order, customerId, merchantId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await returns.approve(request.id, ACTOR, { merchantId });

    expect(await trialBalance()).toBe(0);
  });

  it('raises a refund the disbursement sweep will pick up', async () => {
    const { order, customerId, merchantId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await returns.approve(request.id, ACTOR, { merchantId });

    const [refund] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.order_return_id, request.id));
    expect(refund).toMatchObject({
      status: 'initiated',
      amount_pesewas: order.total_pesewas,
      // Paystack, because the order settled under a provider reference. Without
      // one this would be `manual` and the sweep would leave it alone rather
      // than retrying against something Paystack can never settle.
      method: 'paystack',
      customer_plan_id: null,
      schedule_id: null,
    });
    expect(refund?.provider_transaction_reference).toBe(order.payment_reference);
    expect((await refunds.findUnsent()).map((r) => r.id)).toContain(refund!.id);
  });

  it('refuses to decide the same return twice', async () => {
    const { order, customerId, merchantId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });
    await returns.approve(request.id, ACTOR, { merchantId });

    await expect(returns.approve(request.id, ACTOR, { merchantId })).rejects.toBeInstanceOf(
      ReturnAlreadyDecidedError,
    );
  });

  it('never lets another merchant decide it', async () => {
    const { order, customerId } = await paidOrder();
    const theirs = await shop();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await expect(
      returns.approve(request.id, ACTOR, { merchantId: theirs.merchantId }),
    ).rejects.toBeInstanceOf(OrderNotReturnableError);
  });

  it('accepts a return after delivery, which is the ordinary case', async () => {
    const { order, customerId, merchantId, variantId } = await paidOrder();
    await fulfilment.markShipped(order.id, { courier_name: 'Swift' }, ACTOR);
    await fulfilment.markDelivered(order.id, { received_by: 'Ama' }, ACTOR);
    const request = await returns.request(customerId, order.id, { reason: 'Not as described' });

    await returns.approve(request.id, ACTOR, { merchantId });

    const [returned] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(returned?.status).toBe('returned');
    expect(await stockOf(variantId)).toBe(10);
  });

  // ------------------------------------------------------------------- reject

  it('refuses the return with a reason, and changes nothing else', async () => {
    const { order, customerId, merchantId, variantId } = await paidOrder();
    const payableBefore = await ledger.balanceOf('merchant_payable', merchantId);
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const rejected = await returns.reject(
      request.id,
      { decision_note: 'Worn, with the tag removed' },
      ACTOR,
      { merchantId },
    );

    expect(rejected).toMatchObject({
      status: 'rejected',
      decision_note: 'Worn, with the tag removed',
    });
    // The sale stands: the order, the stock and the books are all untouched.
    const [order2] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(order2?.status).toBe('paid');
    expect(await stockOf(variantId)).toBe(9);
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(payableBefore);
    expect(
      await db.select().from(schema.refunds).where(eq(schema.refunds.order_return_id, request.id)),
    ).toHaveLength(0);
  });

  it('lets the buyer ask again after a refusal', async () => {
    // The partial unique index is on open returns only, so a refusal is not a
    // dead end — which is where a dispute starts, and the buyer can at least
    // re-state their case.
    const { order, customerId, merchantId } = await paidOrder();
    const first = await returns.request(customerId, order.id, { reason: 'Wrong size' });
    await returns.reject(first.id, { decision_note: 'Worn' }, ACTOR, { merchantId });

    const second = await returns.request(customerId, order.id, {
      reason: 'It was never worn — here are photos',
    });

    expect(second.status).toBe('requested');
    expect(second.id).not.toBe(first.id);
  });

  // -------------------------------------------------------------------- reads

  it('scopes the queue to the merchant’s own sales', async () => {
    const mine = await paidOrder();
    const theirs = await paidOrder();
    await returns.request(mine.customerId, mine.order.id, { reason: 'Wrong size' });
    await returns.request(theirs.customerId, theirs.order.id, { reason: 'Wrong colour' });

    const queue = await returns.list({ status: 'requested' }, { merchantId: mine.merchantId });

    expect(queue.map((r) => r.order_id)).toEqual([mine.order.id]);
  });

  it('lists a buyer’s own returns', async () => {
    const { order, customerId } = await paidOrder();
    await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const mine = await returns.listForCustomer(customerId);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.order_id).toBe(order.id);
  });

  // ------------------------------------------------------------------- schema

  it('refuses a refusal with no reason', async () => {
    // `order_returns_rejection_needs_note`: "no" that does not say why is not
    // something a buyer can act on.
    const { order, customerId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await expect(
      db
        .update(schema.order_returns)
        .set({ status: 'rejected', decided_at: new Date().toISOString() })
        .where(eq(schema.order_returns.id, request.id)),
    ).rejects.toThrow();
  });

  it('refuses half a decision', async () => {
    // `order_returns_decided_together`: an outcome and a timestamp, or neither.
    const { order, customerId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await expect(
      db
        .update(schema.order_returns)
        .set({ status: 'approved' })
        .where(eq(schema.order_returns.id, request.id)),
    ).rejects.toThrow();
  });

  it('refuses a refund that belongs to both a schedule and a return', async () => {
    // `refunds_one_owner`. Two owners would double-count the liability and give
    // the disbursement sweep two places to send the same money.
    const { order, customerId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await expect(
      db.insert(schema.refunds).values({
        order_return_id: request.id,
        customer_plan_id: randomUUID(),
        schedule_id: randomUUID(),
        amount_pesewas: 100,
        reference: `bogus:${randomUUID()}`,
        method: 'manual',
      }),
    ).rejects.toThrow();
  });
});
