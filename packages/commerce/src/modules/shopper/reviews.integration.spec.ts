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
  ReserveReleaseService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { FulfilmentService } from '../fulfilment/fulfilment.service';
import { ReviewsService } from './reviews.service';
import { ReviewConflictError, ReviewNotAllowedError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Reviews, against Postgres. The first test coverage this module has ever had.
 *
 * `ReviewsService` shipped with no spec anywhere — not in commerce, not in
 * apps/api — and no client called either of its routes, so nothing exercised
 * it at all. Two of the tests below are about a disagreement that state let
 * survive: `reviewable()` listed order lines whose `product_id` had gone NULL
 * (a delisted product; the column is ON DELETE SET NULL) while `create()`
 * refuses exactly those with "This product is no longer listed". The pending
 * queue could hand a buyer a card whose only possible outcome was a 422.
 *
 * That is this codebase's recurring shape once more: two halves of one rule,
 * each correct on its own, disagreeing in a way no single reading catches.
 */
describe.skipIf(!RUN_DB)('ReviewsService (integration)', () => {
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
  const cart = new CartService(db);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const reviews = new ReviewsService(db);
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
        email: `rev-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  async function shop(displayName = 'Adepa Couture') {
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
      { merchant_id: merchant.id, slug: `shop-${id.slice(0, 8)}`, display_name: displayName },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id };
  }

  /** A delivered order for one product, which is the only reviewable state. */
  async function delivered(opts: { customerId?: string; title?: string; shopName?: string } = {}) {
    const customerId = opts.customerId ?? (await shopper());
    const { merchantId, storeId } = await shop(opts.shopName);
    const product = await products.create(
      {
        store_id: storeId,
        title: opts.title ?? 'Ankara Wrap Dress',
        base_price_pesewas: 32_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 10 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      raised!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    await fulfilment.markShipped(paid.id, {}, ACTOR, { merchantId });
    const done = await fulfilment.markDelivered(paid.id, {}, ACTOR, { merchantId });
    return { order: done, customerId, merchantId, productId: product.id };
  }

  async function lineOf(orderId: string): Promise<string> {
    const rows = await db
      .select({ id: schema.order_items.id })
      .from(schema.order_items)
      .where(eq(schema.order_items.order_id, orderId))
      .limit(1);
    return rows[0]!.id;
  }

  // --------------------------------------------------------------- reviewable

  it('offers a delivered line, with enough to recognise the purchase', async () => {
    const { order, customerId } = await delivered({
      title: 'Ankara Wrap Dress',
      shopName: 'Adepa Couture',
    });

    const [pending] = await reviews.reviewable(customerId);

    expect(pending).toMatchObject({
      order_id: order.id,
      title: 'Ankara Wrap Dress',
      // Both joined in this slice. Without them the card reads as a bare
      // product name six weeks after the fact, which is not a thing anyone
      // recognises well enough to have an opinion about.
      store_name: 'Adepa Couture',
      order_number: order.order_number,
    });
    expect(pending?.delivered_at).not.toBeNull();
  });

  it('does not offer an order that has not arrived', async () => {
    // The gate is `orders.status IN ('delivered','completed')` and nothing
    // else — not a shipment row, not a date.
    const customerId = await shopper();
    const { merchantId, storeId } = await shop();
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Kente Scarf',
        base_price_pesewas: 6_990,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 5 },
        ],
      },
      ACTOR,
    );
    await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      raised!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    await fulfilment.markShipped(paid.id, {}, ACTOR, { merchantId });

    expect(await reviews.reviewable(customerId)).toHaveLength(0);
  });

  it('never offers a line that create() would refuse', async () => {
    // THE BUG. `order_items.product_id` is ON DELETE SET NULL, so delisting a
    // product empties it — and `create` throws ReviewNotAllowedError on
    // exactly that. Before this, the line stayed on the pending list and its
    // Rate button led to a form that could only ever 422.
    const { order, customerId } = await delivered();
    const lineId = await lineOf(order.id);
    expect(await reviews.reviewable(customerId)).toHaveLength(1);

    await db
      .update(schema.order_items)
      .set({ product_id: null })
      .where(eq(schema.order_items.id, lineId));

    expect(await reviews.reviewable(customerId)).toHaveLength(0);
    // The two halves now agree — which is the assertion, not the emptiness.
    await expect(reviews.create(customerId, { order_item_id: lineId, rating: 5 })).rejects.toThrow(
      ReviewNotAllowedError,
    );
  });

  it('drops a line once it has been reviewed', async () => {
    const { order, customerId } = await delivered();
    const lineId = await lineOf(order.id);

    await reviews.create(customerId, { order_item_id: lineId, rating: 5 });

    expect(await reviews.reviewable(customerId)).toHaveLength(0);
  });

  it('shows one buyer only their own purchases', async () => {
    const mine = await delivered({ title: 'Mine' });
    const theirs = await delivered({ title: 'Theirs' });

    const rows = await reviews.reviewable(mine.customerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Mine');
    expect(theirs.customerId).not.toBe(mine.customerId);
  });

  // ------------------------------------------------------------------- create

  it('publishes a rating with no words at all', async () => {
    // `title` and `body` are both optional with no minimum: a star from
    // somebody who received the thing is worth more than an empty text box is
    // worth insisting on.
    const { order, customerId, productId } = await delivered();

    const review = await reviews.create(customerId, {
      order_item_id: await lineOf(order.id),
      rating: 4,
    });

    expect(review).toMatchObject({ rating: 4, title: null, body: null, status: 'published' });
    expect(review.product_id).toBe(productId);
  });

  it('refuses a second review of the same line', async () => {
    // UNIQUE (order_item_id). A double tap, or a retry after a dropped
    // response, lands here — so the screen needs a state for it.
    const { order, customerId } = await delivered();
    const lineId = await lineOf(order.id);
    await reviews.create(customerId, { order_item_id: lineId, rating: 5 });

    await expect(reviews.create(customerId, { order_item_id: lineId, rating: 1 })).rejects.toThrow(
      ReviewConflictError,
    );
  });

  it('refuses somebody else’s order line', async () => {
    const mine = await shopper();
    const theirs = await delivered();

    await expect(
      reviews.create(mine, { order_item_id: await lineOf(theirs.order.id), rating: 5 }),
    ).rejects.toThrow(ReviewNotAllowedError);
  });

  it('refuses a rating outside one to five, and a rating sent as text', async () => {
    const { order, customerId } = await delivered();
    const order_item_id = await lineOf(order.id);

    for (const rating of [0, 6, 4.5, '5']) {
      await expect(reviews.create(customerId, { order_item_id, rating })).rejects.toThrow();
    }
    // The string case is worth its own note: `rating` is a strict z.number()
    // with no coercion, unlike every other numeric field in this contract. A
    // form handing over "5" gets a validation error, not a review.
  });
});
