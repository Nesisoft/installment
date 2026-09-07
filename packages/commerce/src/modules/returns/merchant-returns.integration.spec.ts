import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  PayoutRecorder,
  RefundService,
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
import { ReturnsService } from './returns.service';
import { MerchantReturnsService } from './merchant-returns.service';
import { ReturnNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The seller's returns queue, against Postgres.
 *
 * `GET /merchant/returns` has existed since the returns slice and answers with
 * bare `order_returns` rows: an order id, a customer id and two amounts. A
 * seller deciding on a return is deciding about a sale, and none of the sale is
 * on that row — so the app could not show a queue, and the seller could not
 * decide anything from their phone.
 *
 * The number that matters most here is `merchantLosesPesewas`. Approving
 * reverses the seller's net at the ORDER's own `commission_bps`, and that is
 * what the ledger books. A screen that recomputed it from the merchant's
 * current default rate would be wrong for every order placed before the last
 * rate change — so these tests assert the projection against what `approve`
 * actually writes, not against arithmetic repeated in the test.
 */
describe.skipIf(!RUN_DB)('MerchantReturnsService (integration)', () => {
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
  const refunds = new RefundService(db, ledger, audit);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const returns = new ReturnsService(db, ledger, audit, inventory, refunds);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const merchantReturns = new MerchantReturnsService(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function shopper(name = 'Ama Boateng'): Promise<string> {
    const [first = 'Ama', last = 'Boateng'] = name.split(' ');
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: first,
        last_name: last,
        email: `mret-${randomUUID()}@fixture.local`,
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
        email: `mret+${id}@example.gh`,
        phone: '+233244555555',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `mret-${id.slice(0, 8)}`, display_name: 'Shop' },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id };
  }

  /** A paid, outright order the buyer can ask to send back. */
  async function paidOrder(
    opts: {
      price?: number;
      titles?: string[];
      buyer?: string;
      shopIds?: Awaited<ReturnType<typeof shop>>;
    } = {},
  ) {
    const price = opts.price ?? 32_000;
    const titles = opts.titles ?? ['Ankara Wrap Dress'];
    const customerId = await shopper(opts.buyer);
    const ids = opts.shopIds ?? (await shop());

    for (const title of titles) {
      const product = await products.create(
        {
          store_id: ids.storeId,
          title,
          base_price_pesewas: price,
          status: 'active',
          variants: [
            { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 10 },
          ],
        },
        ACTOR,
      );
      await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    }

    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      raised!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    return { order: paid, customerId, ...ids };
  }

  // ------------------------------------------------------------------- queue

  it('carries the sale, the buyer and what deciding costs — none of which is on the row', async () => {
    const { order, merchantId, customerId } = await paidOrder({ buyer: 'Kofi Mensah' });
    await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const { rows, total } = await merchantReturns.list(merchantId);

    expect(total).toBe(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'requested',
      reason: 'Wrong size',
      refundPesewas: order.total_pesewas,
      buyerName: 'Kofi Mensah',
      itemSummary: 'Ankara Wrap Dress',
      decidedAt: null,
      decisionNote: null,
    });
    // The two halves of the reversal add back up to the order, which is what
    // makes the ledger balance when it is booked.
    expect(row.merchantLosesPesewas + row.commissionReversedPesewas).toBe(order.total_pesewas);
    expect(row.commissionReversedPesewas).toBeGreaterThan(0);
  });

  it('promises exactly what approving actually takes off the seller', async () => {
    // The assertion this whole projection exists for. The screen tells a seller
    // "approving costs you X"; `approve` then debits `merchant_payable`. If the
    // two ever disagree the app is lying about money.
    const { order, merchantId, customerId } = await paidOrder({ price: 28_990 });
    const request = await returns.request(customerId, order.id, { reason: 'Cracked' });
    const promised = (await merchantReturns.detail(merchantId, request.id)).merchantLosesPesewas;

    await returns.approve(request.id, ACTOR, { merchantId });

    const entries = await db.select().from(schema.ledger_entries);
    const debited = entries
      .filter(
        (e) =>
          e.transaction_id === `order-return:${request.id}` &&
          e.account_type === 'merchant_payable' &&
          e.direction === 'debit',
      )
      .reduce((sum, e) => sum + Number(e.amount_pesewas), 0);

    expect(debited).toBe(promised);
  });

  it('summarises a multi-line order rather than naming one thing', async () => {
    const { order, merchantId, customerId } = await paidOrder({
      titles: ['Ankara Wrap Dress', 'Kente Scarf', 'Beaded Bag'],
    });
    await returns.request(customerId, order.id, { reason: 'All wrong' });

    const { rows } = await merchantReturns.list(merchantId);

    // Which title leads is the uuid tiebreak's choice, not the seller's cart
    // order, so only the shape is assertable — the "+ 2 more" is the part that
    // has to be right.
    expect(rows[0]?.itemSummary).toMatch(/^(Ankara Wrap Dress|Kente Scarf|Beaded Bag) \+ 2 more$/);
  });

  it('puts what is waiting on the seller first, whatever its age', async () => {
    // A queue that buried one open request under thirty settled ones is a queue
    // a seller stops opening.
    const ids = await shop();
    const older = await paidOrder({ shopIds: ids });
    const newer = await paidOrder({ shopIds: ids });

    const settled = await returns.request(older.customerId, older.order.id, { reason: 'First' });
    await returns.reject(settled.id, { decision_note: 'Outside the window' }, ACTOR, {
      merchantId: ids.merchantId,
    });
    const open = await returns.request(newer.customerId, newer.order.id, { reason: 'Second' });

    const { rows } = await merchantReturns.list(ids.merchantId);

    expect(rows.map((r) => r.id)).toEqual([open.id, settled.id]);
  });

  it('counts every bucket over the whole set, not the page', async () => {
    const ids = await shop();
    const a = await paidOrder({ shopIds: ids });
    const b = await paidOrder({ shopIds: ids });
    const requested = await returns.request(a.customerId, a.order.id, { reason: 'One' });
    const rejected = await returns.request(b.customerId, b.order.id, { reason: 'Two' });
    await returns.reject(rejected.id, { decision_note: 'No' }, ACTOR, {
      merchantId: ids.merchantId,
    });

    const counts = await merchantReturns.counts(ids.merchantId);

    expect(counts).toMatchObject({ requested: 1, rejected: 1, approved: 0, cancelled: 0, all: 2 });
    // Asking for one page of one must not change what the chips say.
    const page = await merchantReturns.list(ids.merchantId, { limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.rows[0]?.id).toBe(requested.id);
  });

  it('filters to one bucket', async () => {
    const ids = await shop();
    const a = await paidOrder({ shopIds: ids });
    const b = await paidOrder({ shopIds: ids });
    await returns.request(a.customerId, a.order.id, { reason: 'One' });
    const rejected = await returns.request(b.customerId, b.order.id, { reason: 'Two' });
    await returns.reject(rejected.id, { decision_note: 'No' }, ACTOR, {
      merchantId: ids.merchantId,
    });

    const open = await merchantReturns.list(ids.merchantId, { bucket: 'requested' });
    const refused = await merchantReturns.list(ids.merchantId, { bucket: 'rejected' });

    expect(open.rows).toHaveLength(1);
    expect(refused.rows.map((r) => r.id)).toEqual([rejected.id]);
    expect(refused.rows[0]?.decisionNote).toBe('No');
    expect(refused.rows[0]?.decidedAt).not.toBeNull();
  });

  // ------------------------------------------------------------------ detail

  it('opens a return that is not on the first page', async () => {
    // The bug the plan detail had: filtering a capped list page rather than
    // querying by id, so anything past the cap was listed and not openable.
    const ids = await shop();
    const first = await paidOrder({ shopIds: ids });
    const second = await paidOrder({ shopIds: ids });
    const buried = await returns.request(first.customerId, first.order.id, { reason: 'Older' });
    await returns.request(second.customerId, second.order.id, { reason: 'Newer' });

    const page = await merchantReturns.list(ids.merchantId, { limit: 1 });
    expect(page.rows.map((r) => r.id)).not.toContain(buried.id);

    const detail = await merchantReturns.detail(ids.merchantId, buried.id);
    expect(detail.id).toBe(buried.id);
  });

  it('lists every line of the order, so the seller sees what is coming back', async () => {
    const { order, merchantId, customerId } = await paidOrder({
      titles: ['Ankara Wrap Dress', 'Kente Scarf'],
      price: 15_000,
    });
    const request = await returns.request(customerId, order.id, { reason: 'Both wrong' });

    const detail = await merchantReturns.detail(merchantId, request.id);

    expect(detail.items).toHaveLength(2);
    // Sorted before comparing, because the query does NOT promise insertion
    // order and asserting one would be asserting a coincidence. Every line of
    // an order is inserted in the same statement and shares `created_at` to the
    // microsecond, so the `id` tiebreak decides — and that is a random uuid.
    // Stable across reads, arbitrary in sequence. See §6 of the merchant design
    // doc: `order_items` needs a `position` column, exactly as
    // `product_variants` did, and until it has one no screen may claim an order.
    expect(detail.items.map((i) => i.title).sort()).toEqual(['Ankara Wrap Dress', 'Kente Scarf']);
    expect(detail.items.every((i) => i.quantity === 1)).toBe(true);
    expect(detail.orderTotalPesewas).toBe(order.total_pesewas);
    expect(detail.orderStatus).toBe('paid');
  });

  it('reflects the decision once one is made', async () => {
    const { order, merchantId, customerId } = await paidOrder();
    const request = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await returns.approve(request.id, ACTOR, { merchantId });
    const detail = await merchantReturns.detail(merchantId, request.id);

    expect(detail.status).toBe('approved');
    expect(detail.decidedAt).not.toBeNull();
    // The order is no longer a sale, and the queue says so alongside the return.
    expect(detail.orderStatus).toBe('returned');
  });

  // ------------------------------------------------------------------- scope

  it('does not show one seller another seller’s returns', async () => {
    const mine = await paidOrder();
    const theirs = await paidOrder();
    await returns.request(mine.customerId, mine.order.id, { reason: 'Mine' });
    await returns.request(theirs.customerId, theirs.order.id, { reason: 'Theirs' });

    const { rows, total } = await merchantReturns.list(mine.merchantId);

    expect(total).toBe(1);
    expect(rows[0]?.reason).toBe('Mine');
    expect(await merchantReturns.counts(mine.merchantId)).toMatchObject({ all: 1 });
  });

  it('answers not-found, never forbidden, for another seller’s return', async () => {
    // A 403 would confirm the return exists, which turns uuid enumeration into
    // a leak of who is returning what to whom.
    const theirs = await paidOrder();
    const mine = await shop();
    const request = await returns.request(theirs.customerId, theirs.order.id, { reason: 'Theirs' });

    await expect(merchantReturns.detail(mine.merchantId, request.id)).rejects.toBeInstanceOf(
      ReturnNotFoundError,
    );
  });
});
