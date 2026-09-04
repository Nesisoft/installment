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
  PlanTemplatesService,
  ReserveReleaseService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { MerchantStatsService } from './merchant-stats.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;

/**
 * The reachability proof.
 *
 * A stats endpoint is the easiest thing in this repository to ship dead: every
 * query would pass a unit test over hand-inserted rows and still report zero
 * forever, because the columns it reads are written somewhere else entirely.
 * `push_devices` was exactly that, for four migrations.
 *
 * So nothing here inserts an order. Every number is produced by driving real
 * checkouts through `OrdersService` — paid outright, financed, cancelled before
 * payment, cancelled after it — and then asking the stats service what it sees.
 * If `placed_at` stopped being stamped, or the accrual transaction id changed
 * shape, or `order.cancelled` stopped being recorded, this file fails.
 */
describe.skipIf(!RUN_DB)('MerchantStatsService (integration)', () => {
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
  // The real settlement plumbing: without it a financed order books no
  // `merchant_payable` credit at all and `netEarned` would be a permanent zero.
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves);
  const templates = new PlanTemplatesService(db, audit);
  const cart = new CartService(db);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit);
  const stats = new MerchantStatsService(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(): Promise<string> {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Akosua',
        last_name: 'Owusu',
        email: `stats+${id}@example.gh`,
        phone: `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
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

  async function variant(storeId: string, price: number) {
    const product = await products.create(
      {
        store_id: storeId,
        title: 'Ankara Wrap Dress',
        base_price_pesewas: price,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 500 },
        ],
      },
      ACTOR,
    );
    return product.variants[0]!.id;
  }

  /** A completed outright sale, placed on `when`. */
  async function sellOutright(storeId: string, price: number, when: Date) {
    const customerId = await freshCustomer();
    const v = await variant(storeId, price);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    return orders.confirmPayment(
      order!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
      when,
    );
  }

  /** A financed sale that has gone live, placed on `when`. */
  async function sellFinanced(storeId: string, price: number, when: Date) {
    const customerId = await freshCustomer();
    const v = await variant(storeId, price);
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
    await applications.recordDecision(order!.application_id!, { outcome: 'approved' }, ACTOR);
    return orders.activateFinancing(order!.id, ACTOR, when);
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
  const today = () => new Date();

  // ------------------------------------------------------------ outright sale

  it('counts an outright sale, and reports what the ledger says is the merchant’s', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 32_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.orders).toBe(1);
    expect(s.current.grossSoldPesewas).toBe(32_000);
    expect(s.current.averageBasketPesewas).toBe(32_000);
    // 5% marketplace commission on an outright sale — not recomputed here, read
    // back out of `merchant_payable`.
    expect(s.current.netEarnedPesewas).toBe(30_400);
    expect(s.current.creditedPesewas).toBe(30_400);
  });

  it('averages the basket over the orders, in whole pesewas', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, today());
    await sellOutright(storeId, 20_001, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.orders).toBe(2);
    expect(s.current.grossSoldPesewas).toBe(30_001);
    // Floored, never a float: 15000.5 pesewas is not a thing that exists.
    expect(s.current.averageBasketPesewas).toBe(15_000);
  });

  // ------------------------------------------------------------ financed sale

  it('counts a financed sale from the moment the plan goes live, net of MDR and reserve', async () => {
    const { merchantId, storeId } = await shop();
    await sellFinanced(storeId, 40_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.orders).toBe(1);
    expect(s.current.grossSoldPesewas).toBe(40_000);
    // 4% MDR + 5% reserve on the bnpl model.
    expect(s.current.netEarnedPesewas).toBe(36_400);
  });

  it('ignores an order still waiting on the credit engine', async () => {
    const { merchantId, storeId } = await shop();
    const customerId = await freshCustomer();
    const v = await variant(storeId, 25_000);
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
    await orders.checkout(
      customerId,
      { payment_type: 'installment', plan_template_id: template },
      ACTOR,
    );

    const s = await stats.forMerchant(merchantId, { days: 7 });

    // `pending_approval` is with underwriting. Counting it would tell a
    // merchant they had sold something that may yet be declined.
    expect(s.current.orders).toBe(0);
    expect(s.current.grossSoldPesewas).toBe(0);
  });

  it('ignores a checkout nobody paid for', async () => {
    const { merchantId, storeId } = await shop();
    const customerId = await freshCustomer();
    const v = await variant(storeId, 18_000);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);

    expect((await stats.forMerchant(merchantId, { days: 7 })).current.orders).toBe(0);
  });

  // ------------------------------------------------------- the payment split

  it('splits the period by how it was paid for, and the two sides reconcile', async () => {
    const { merchantId, storeId } = await shop();
    await sellFinanced(storeId, 40_000, today());
    await sellFinanced(storeId, 20_000, today());
    await sellFinanced(storeId, 30_000, today());
    await sellOutright(storeId, 10_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });
    const { installment, full } = s.current.paymentMix;

    expect(installment).toMatchObject({
      orders: 3,
      grossSoldPesewas: 90_000,
      averageBasketPesewas: 30_000,
      shareOfOrdersPct: 75,
    });
    expect(full).toMatchObject({
      orders: 1,
      grossSoldPesewas: 10_000,
      averageBasketPesewas: 10_000,
      shareOfOrdersPct: 25,
    });

    // The property worth having: the split is the headline, added up a
    // different way. A mix that did not reconcile with the number above it on
    // the screen would be worse than no mix at all.
    expect(installment.orders + full.orders).toBe(s.current.orders);
    expect(installment.grossSoldPesewas + full.grossSoldPesewas).toBe(s.current.grossSoldPesewas);
    expect((installment.shareOfOrdersPct ?? 0) + (full.shareOfOrdersPct ?? 0)).toBe(100);
  });

  it('says nothing rather than 0% when the period sold nothing', async () => {
    const { merchantId } = await shop();

    const { installment, full } = (await stats.forMerchant(merchantId, { days: 7 })).current
      .paymentMix;

    // "0% paid in instalments" for a shop that sold nothing is a false
    // statement, not a zero.
    expect(installment).toMatchObject({ orders: 0, grossSoldPesewas: 0, shareOfOrdersPct: null });
    expect(full).toMatchObject({ orders: 0, shareOfOrdersPct: null });
  });

  it('reads 100% to one side when only one kind of sale happened', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 12_000, today());

    const { installment, full } = (await stats.forMerchant(merchantId, { days: 7 })).current
      .paymentMix;

    expect(full.shareOfOrdersPct).toBe(100);
    expect(installment.shareOfOrdersPct).toBe(0);
    expect(installment.averageBasketPesewas).toBe(0);
  });

  it('splits the previous period on its own orders, not the current one’s', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, daysAgo(2)); // current window
    await sellFinanced(storeId, 40_000, daysAgo(9)); // the one before

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.paymentMix.full.orders).toBe(1);
    expect(s.current.paymentMix.installment.orders).toBe(0);
    expect(s.previous.paymentMix.installment.orders).toBe(1);
    expect(s.previous.paymentMix.full.orders).toBe(0);
  });

  it('leaves an abandoned checkout out of the split, as it does out of the total', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, today());
    await abandon(storeId, 90_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    // The split comes off the same rows as the headline, so the exclusion is
    // inherited rather than re-stated — this pins that it actually is.
    expect(s.current.paymentMix.full.orders).toBe(1);
    expect(s.current.paymentMix.full.grossSoldPesewas).toBe(10_000);
    expect(s.current.cancelledOrders).toBe(1);
  });

  it('keeps the daily chart one bar per day when a day has both kinds', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, today());
    await sellFinanced(storeId, 20_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    // Two rows come back from the group-by for the same day; the chart wants
    // them added, not listed twice.
    const traded = s.daily.filter((d) => d.orders > 0);
    expect(traded).toHaveLength(1);
    expect(traded[0]).toMatchObject({ orders: 2, grossSoldPesewas: 30_000 });
  });

  // ----------------------------------------------------------- cancellations

  async function abandon(storeId: string, price: number, when: Date) {
    const customerId = await freshCustomer();
    const v = await variant(storeId, price);
    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    return orders.cancel(order!.id, { reason: 'Abandoned — swept' }, ACTOR, {}, when);
  }

  it('counts an abandoned checkout, and what it would have been worth', async () => {
    const { merchantId, storeId } = await shop();
    await abandon(storeId, 12_000, today());
    await abandon(storeId, 31_000, today());
    await sellOutright(storeId, 20_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.cancelledOrders).toBe(2);
    expect(s.current.cancelledValuePesewas).toBe(43_000);
    // And an abandoned checkout was never a sale.
    expect(s.current.orders).toBe(1);
    expect(s.current.grossSoldPesewas).toBe(20_000);
  });

  it('counts a cancellation on the day it was cancelled', async () => {
    const { merchantId, storeId } = await shop();
    await abandon(storeId, 20_000, daysAgo(1));
    await abandon(storeId, 40_000, daysAgo(9));

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.cancelledOrders).toBe(1);
    expect(s.current.cancelledValuePesewas).toBe(20_000);
    expect(s.previous.cancelledOrders).toBe(1);
    expect(s.previous.cancelledValuePesewas).toBe(40_000);
  });

  it('cannot cancel a paid order at all — which is why there is one cancellation number', async () => {
    // Pinning the reason this API has no "cancelled after payment" figure.
    // `CANCELLABLE_STATUSES` is pending_payment / pending_approval /
    // payment_failed, and nothing else in the repository writes
    // `orders.status = 'cancelled'`. A tile counting post-payment cancellations
    // could only ever read zero, so it does not exist. If this test ever starts
    // failing, that decision needs revisiting rather than deleting.
    const { storeId } = await shop();
    const paid = await sellOutright(storeId, 50_000, today());

    await expect(orders.cancel(paid.id, { reason: 'Out of stock' }, ACTOR)).rejects.toThrow();
  });

  // ------------------------------------------------------------- the windows

  it('puts a sale in the window it was placed in, and compares against the one before', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, daysAgo(2)); // current 7-day window
    await sellOutright(storeId, 40_000, daysAgo(9)); // the 7 days before that

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.current.grossSoldPesewas).toBe(10_000);
    expect(s.previous.grossSoldPesewas).toBe(40_000);
    expect(s.change.grossSoldPct).toBe(-75);
    expect(s.change.ordersPct).toBe(0);
  });

  it('widens to 30 and 90 days, taking in what the 7-day window could not see', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, daysAgo(3));
    await sellOutright(storeId, 20_000, daysAgo(20));
    await sellOutright(storeId, 40_000, daysAgo(60));

    expect((await stats.forMerchant(merchantId, { days: 7 })).current.grossSoldPesewas).toBe(
      10_000,
    );
    expect((await stats.forMerchant(merchantId, { days: 30 })).current.grossSoldPesewas).toBe(
      30_000,
    );
    expect((await stats.forMerchant(merchantId, { days: 90 })).current.grossSoldPesewas).toBe(
      70_000,
    );
  });

  it('says nothing rather than infinity when there is no previous period', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000, today());

    const s = await stats.forMerchant(merchantId, { days: 7 });

    expect(s.previous.grossSoldPesewas).toBe(0);
    // A first week is not "up ∞%".
    expect(s.change.grossSoldPct).toBeNull();
    expect(s.change.ordersPct).toBeNull();
  });

  // ---------------------------------------------------- earned vs credited

  it('separates what a period earned from what it was credited', async () => {
    const { merchantId, storeId } = await shop();
    // Sold five weeks ago; the ledger booked the credit when it was booked,
    // which for a backdated fixture is now.
    await sellOutright(storeId, 32_000, daysAgo(35));

    const s = await stats.forMerchant(merchantId, { days: 7 });

    // Nothing was sold this week...
    expect(s.current.grossSoldPesewas).toBe(0);
    expect(s.current.netEarnedPesewas).toBe(0);
    // ...but money landed in the account this week. This is why both numbers
    // exist: one pairs with the sales figure, the other reconciles with the
    // statement, and a reserve released today for a sale from March would
    // otherwise have to be one or the other.
    expect(s.current.creditedPesewas).toBe(30_400);
  });

  // ----------------------------------------------------------- the bar chart

  it('returns every day in the window, including the ones with no trade', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 15_000, daysAgo(3));

    const s = await stats.forMerchant(merchantId, { days: 7 });

    // Seven bars for seven days. A sparse series is what makes a chart lie.
    expect(s.daily).toHaveLength(7);
    expect(s.daily.map((d) => d.date)).toEqual([...s.daily.map((d) => d.date)].sort());
    const traded = s.daily.filter((d) => d.orders > 0);
    expect(traded).toHaveLength(1);
    expect(traded[0]?.grossSoldPesewas).toBe(15_000);
    expect(s.daily.filter((d) => d.orders === 0)).toHaveLength(6);
    expect((await stats.forMerchant(merchantId, { days: 90 })).daily).toHaveLength(90);
  });

  // -------------------------------------------------------------- isolation

  it('never counts another merchant’s trade', async () => {
    const mine = await shop();
    const theirs = await shop();
    await sellOutright(mine.storeId, 11_000, today());
    await sellOutright(theirs.storeId, 99_000, today());

    const s = await stats.forMerchant(mine.merchantId, { days: 7 });

    expect(s.current.grossSoldPesewas).toBe(11_000);
    expect(s.current.orders).toBe(1);
  });

  // ------------------------------------------------------------- the window

  it('refuses a window it does not have, rather than quietly serving another', async () => {
    const { merchantId } = await shop();

    await expect(stats.forMerchant(merchantId, { days: 45 })).rejects.toThrow();
    await expect(stats.forMerchant(merchantId, { days: 0 })).rejects.toThrow();
    expect((await stats.forMerchant(merchantId)).windowDays).toBe(30);
    // Query strings arrive as strings.
    expect((await stats.forMerchant(merchantId, { days: '90' })).windowDays).toBe(90);
  });

  it('reports zeroes for a merchant who has never sold anything', async () => {
    const { merchantId } = await shop();

    const s = await stats.forMerchant(merchantId, { days: 30 });

    expect(s.current).toMatchObject({
      orders: 0,
      grossSoldPesewas: 0,
      averageBasketPesewas: 0,
      netEarnedPesewas: 0,
      creditedPesewas: 0,
      cancelledOrders: 0,
      cancelledValuePesewas: 0,
    });
    expect(s.change.grossSoldPct).toBeNull();
    expect(s.daily).toHaveLength(30);
  });
});
