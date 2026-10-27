import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CollectionsService,
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
import { FulfilmentService } from '../fulfilment/fulfilment.service';
import { AddressesService } from './addresses.service';
import { CartService } from './cart.service';
import { OrdersService } from './orders.service';
import { OrderNotFoundError } from './errors';
import { MerchantOrdersService } from './merchant-orders.service';
import { ReturnsService } from '../returns/returns.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;

/**
 * The reachability proof.
 *
 * Every figure the seller's queue and order sheet draw is a projection over
 * columns something else writes: `placed_at` at payment, the ledger under a
 * transaction id built in another package, `order_events` inside the fulfilment
 * transaction, the schedule inside the engine's. A unit test over hand-inserted
 * rows would pass against every one of those writers being renamed or deleted.
 *
 * So nothing here inserts an order. Every order is driven through the real
 * `OrdersService.checkout` / `confirmPayment` / `activateFinancing`, the real
 * `FulfilmentService`, and the real settlement plumbing, and then the service is
 * asked what it sees. If the accrual transaction id changes shape, or
 * `order_events` stops being written, or `placed_at` stops being stamped, this
 * file fails.
 *
 * The cloned worker databases are built from migrations and truncated before
 * each spec file, so the seeded delivery zones and every pickup hub are gone by
 * the time this runs — the reference data a test needs, it inserts.
 */
describe.skipIf(!RUN_DB)('MerchantOrdersService (integration)', () => {
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
  // The real settlement plumbing. Without it a financed order books no
  // `merchant_payable` credit and no `held_reserves` row at all, and every
  // settlement figure on the order sheet would read a permanent zero.
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves);
  const templates = new PlanTemplatesService(db, audit);
  const collections = new CollectionsService(db, audit);
  const cart = new CartService(db);
  const addresses = new AddressesService(db);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const queue = new MerchantOrdersService(db);
  // No refund plumbing: the reversal this spec asserts is the ledger's, which
  // `approve` books itself. Raising the customer's money is a separate seam.
  const orderReturns = new ReturnsService(db, ledger, audit, inventory);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

  async function freshCustomer(): Promise<{ id: string; name: string; phone: string }> {
    const id = randomUUID();
    const phone = `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`;
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Akosua',
        last_name: 'Owusu',
        email: `queue+${id}@example.gh`,
        phone,
      })
      .returning({ id: schema.customers.id });
    return { id: rows[0]!.id, name: 'Akosua Owusu', phone };
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
    return product.variants[0]!;
  }

  /**
   * "Pay in 4": a 40% deposit plus three financed instalments.
   *
   * `number_of_installments` is 3 and the generated schedule has four rows,
   * which is the whole reason the order sheet counts rows rather than reading
   * the column.
   */
  async function payInFour() {
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
    return template.id;
  }

  /** A checkout nobody has paid for: `pending_payment`, no `placed_at`. */
  async function unpaid(storeId: string, price: number, quantity = 1) {
    const customer = await freshCustomer();
    const v = await variant(storeId, price);
    await cart.addItem(customer.id, { variant_id: v.id, quantity });
    const [order] = await orders.checkout(customer.id, { payment_type: 'full' }, ACTOR);
    return { order: order!, customer, variant: v };
  }

  /**
   * A paid outright sale, placed on `when` — or on the clock at the moment it is
   * paid for, which is not the same as a default argument: a `new Date()`
   * evaluated when the helper is entered predates the checkout it is about to
   * run, and would stamp `order.paid` before `order.created`.
   */
  async function sellOutright(storeId: string, price: number, when?: Date, quantity = 1) {
    const { order, customer, variant: v } = await unpaid(storeId, price, quantity);
    const paid = await orders.confirmPayment(
      order.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
      when ?? new Date(),
    );
    return { order: paid, customer, variant: v };
  }

  /** A financed sale whose plan has gone live, placed on `when`. */
  async function sellFinanced(storeId: string, price: number, when?: Date) {
    const customer = await freshCustomer();
    const v = await variant(storeId, price);
    const templateId = await payInFour();
    await cart.addItem(customer.id, { variant_id: v.id, quantity: 1 });
    const [order] = await orders.checkout(
      customer.id,
      { payment_type: 'installment', plan_template_id: templateId },
      ACTOR,
    );
    await applications.recordDecision(order!.application_id!, { outcome: 'approved' }, ACTOR);
    const financed = await orders.activateFinancing(order!.id, ACTOR, when ?? new Date());
    return { order: financed, customer, variant: v };
  }

  // ------------------------------------------------------------------- counts

  it('maps every status onto the bucket the seller’s tabs are named after', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000); // paid
    await sellFinanced(storeId, 20_000); // financing_active
    const packing = await sellOutright(storeId, 11_000);
    await fulfilment.startFulfilment(packing.order.id, ACTOR, { merchantId });
    const gone = await sellOutright(storeId, 12_000);
    await fulfilment.markShipped(gone.order.id, {}, ACTOR, { merchantId });
    const arrived = await sellOutright(storeId, 13_000);
    await fulfilment.markShipped(arrived.order.id, {}, ACTOR, { merchantId });
    await fulfilment.markDelivered(arrived.order.id, {}, ACTOR, { merchantId });
    const abandoned = await unpaid(storeId, 90_000);
    await orders.cancel(abandoned.order.id, { reason: 'Abandoned — swept' }, ACTOR);

    const counts = await queue.counts(merchantId);

    // `new` is two statuses: an order is the seller's the moment it is paid
    // for, outright or on an approved plan.
    expect(counts.new).toBe(2);
    // There is no `confirmed` status — "Confirm order" writes `fulfilling`.
    expect(counts.confirmed).toBe(1);
    expect(counts.shipped).toBe(1);
    expect(counts.delivered).toBe(1);
    expect(counts.completed).toBe(0);
    // Six orders exist and five buckets show five of them. `all` that quietly
    // dropped the cancelled one would not reconcile with the list the "All" tab
    // actually renders.
    expect(counts.all).toBe(6);
  });

  it('moves an order into completed when the return-window sweep closes it', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 15_000);
    await fulfilment.markShipped(sale.order.id, {}, ACTOR, { merchantId });
    // Delivered long enough ago that the order's own return window has run out.
    await fulfilment.markDelivered(
      sale.order.id,
      { delivered_at: daysAgo(30).toISOString() },
      ACTOR,
      { merchantId },
    );
    expect(await fulfilment.completeElapsedReturnWindows(ACTOR)).toContain(sale.order.id);

    const counts = await queue.counts(merchantId);

    expect(counts.completed).toBe(1);
    expect(counts.delivered).toBe(0);
    expect(counts.all).toBe(1);
  });

  it('reads zero in every bucket for a seller who has never sold anything', async () => {
    const { merchantId } = await shop();

    expect(await queue.counts(merchantId)).toEqual({
      all: 0,
      new: 0,
      confirmed: 0,
      shipped: 0,
      delivered: 0,
      completed: 0,
    });
  });

  // --------------------------------------------------------------------- list

  it('brings the buyer and the order’s lines back with the page', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 32_000, undefined, 6);

    const { rows } = await queue.list(merchantId);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.buyer_name).toBe(sale.customer.name);
    expect(row.buyer_phone).toBe(sale.customer.phone);
    // The line snapshot, which is all `order_items` holds — there are no
    // variant option values on it to render.
    expect(row.items).toHaveLength(1);
    expect(row.items[0]).toMatchObject({
      title: 'Ankara Wrap Dress',
      sku: sale.variant.sku,
      quantity: 6,
      line_total_pesewas: 192_000,
    });
    expect(row.order_number).toBe(sale.order.order_number);
  });

  it('reports what the ledger credited, and null where nothing has been booked', async () => {
    const { merchantId, storeId } = await shop();
    const sold = await sellOutright(storeId, 32_000);
    const awaiting = await unpaid(storeId, 50_000);

    const { rows } = await queue.list(merchantId);
    const byId = new Map(rows.map((r) => [r.id, r]));

    // GHS 320.00 less the 5% marketplace commission, read back out of
    // `merchant_payable` rather than recomputed from the rate.
    expect(byId.get(sold.order.id)?.settled_pesewas).toBe(30_400);
    // Null, not 0: this order has not settled for nothing, it has not settled.
    expect(byId.get(awaiting.order.id)?.settled_pesewas).toBeNull();
  });

  it('counts the total over the bucket it filtered, not the whole queue', async () => {
    const { merchantId, storeId } = await shop();
    await sellOutright(storeId, 10_000);
    await sellOutright(storeId, 11_000);
    const packing = await sellOutright(storeId, 12_000);
    await fulfilment.startFulfilment(packing.order.id, ACTOR, { merchantId });

    const page = await queue.list(merchantId, { bucket: 'new', limit: 1 });

    // One row on the page, but the tab has to say "2" — a total taken over the
    // unfiltered queue would badge every tab with the same number.
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((await queue.list(merchantId)).total).toBe(3);
    expect((await queue.list(merchantId, { bucket: 'confirmed' })).total).toBe(1);
  });

  it('never shows another seller’s order', async () => {
    const mine = await shop();
    const theirs = await shop();
    await sellOutright(mine.storeId, 11_000);
    await sellOutright(theirs.storeId, 99_000);

    const page = await queue.list(mine.merchantId);

    expect(page.total).toBe(1);
    expect(page.rows[0]?.total_pesewas).toBe(11_000);
  });

  it('puts the most recently placed first, and never floats an unplaced order', async () => {
    const { merchantId, storeId } = await shop();
    const older = await sellOutright(storeId, 10_000, daysAgo(3));
    const newer = await sellOutright(storeId, 11_000, daysAgo(1));
    // Created last, so its `created_at` is the newest in the queue — ordering on
    // that instead of `placed_at` would put a cart nobody paid for at the top.
    const abandoned = await unpaid(storeId, 90_000);

    const { rows } = await queue.list(merchantId);

    expect(rows.map((r) => r.id)).toEqual([newer.order.id, older.order.id, abandoned.order.id]);
    expect(rows[2]?.placed_at).toBeNull();
  });

  // ------------------------------------------------------------------- detail

  it('reads an outright settlement out of the ledger — commission, no reserve', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 32_000);

    const detail = await queue.detail(merchantId, sale.order.id);
    const s = detail.settlement;

    expect(s.grossPesewas).toBe(32_000);
    expect(s.feeLabel).toBe('commission');
    expect(s.feeBps).toBe(500);
    expect(s.feePesewas).toBe(1_600);
    expect(s.netPesewas).toBe(30_400);
    // An outright sale withholds nothing — there is no plan to hold it against.
    expect(s.reservePesewas).toBe(0);
    expect(s.reserveBps).toBeNull();
    expect(s.reserveOutstandingPesewas).toBe(0);
    expect(s.reserveReleasesAt).toBeNull();
    expect(s.bookedAt).not.toBeNull();
    // The property worth having: the three ledger legs are the order total, cut
    // up. A settlement that did not reconcile with the total above it on the
    // screen would be worse than no settlement figure at all.
    expect(s.netPesewas + s.feePesewas + s.reservePesewas).toBe(s.grossPesewas);
    expect(detail.plan).toBeNull();
  });

  it('reads a financed sale’s settlement — MDR and reserve on the bnpl model', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);

    const detail = await queue.detail(merchantId, sale.order.id);
    const s = detail.settlement;

    expect(s.grossPesewas).toBe(40_000);
    expect(s.feeLabel).toBe('mdr');
    // The rates frozen onto the plan at activation, not `merchants.default_*`.
    expect(s.feeBps).toBe(400);
    expect(s.reserveBps).toBe(500);
    expect(s.feePesewas).toBe(1_600);
    expect(s.reservePesewas).toBe(2_000);
    expect(s.netPesewas).toBe(36_400);
    expect(s.netPesewas + s.feePesewas + s.reservePesewas).toBe(s.grossPesewas);
    // Still held: nothing has been released and no default has consumed any.
    expect(s.reserveOutstandingPesewas).toBe(2_000);
    // Null while the plan runs, and that is the honest answer rather than a
    // missing one — the release clock starts at completion or default.
    expect(s.reserveReleasesAt).toBeNull();
    expect(detail.plan?.late).toBe(false);
  });

  it('applies the model’s release buffer, rather than handing over the trigger date', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const planId = sale.order.customer_plan_id!;

    // Stamping the completion is the fixture, not the assertion: what is under
    // test is that the service runs the release POLICY over it. The trigger
    // date is what `held_reserves` stores; bnpl's policy is
    // `after_plan_completion` with a 14-day buffer, so the seller's money is
    // free a fortnight later — and handing the raw trigger to a screen would
    // tell them it was free today.
    const completedAt = new Date('2026-09-24T00:00:00.000Z');
    await db
      .update(schema.held_reserves)
      .set({ plan_completed_at: completedAt.toISOString() })
      .where(eq(schema.held_reserves.customer_plan_id, planId));

    const detail = await queue.detail(merchantId, sale.order.id);

    expect(detail.settlement.reserveReleasesAt).not.toBeNull();
    const releases = new Date(detail.settlement.reserveReleasesAt!);
    expect(releases.getTime() - completedAt.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect(releases.toISOString().slice(0, 10)).toBe('2026-10-08');
  });

  it('reports nothing payable once an approved return has reversed the settlement', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 32_000);

    const before = await queue.detail(merchantId, sale.order.id);
    expect(before.settlement.netPesewas).toBe(30_400);

    // The real return path, so the reversal is the one production books.
    const asked = await orderReturns.request(sale.customer.id, sale.order.id, {
      reason: 'The screen arrived cracked',
    });
    await orderReturns.approve(asked.id, ACTOR, { merchantId });

    const after = await queue.detail(merchantId, sale.order.id);

    // The ledger is append-only, so the reversal is a second set of entries
    // under the same transaction. Summing credits alone would still report
    // GHS 304.00 payable on money the seller no longer has — a failure state
    // rendered as a successful payout.
    expect(after.settlement.netPesewas).toBe(0);
    expect(after.status).toBe('returned');
    // Still booked, and the date is the ORIGINAL credit: the seller did settle,
    // and then it came back.
    expect(after.settlement.bookedAt).toBe(before.settlement.bookedAt);
  });

  it('orders an order’s lines the same way twice, though they share a timestamp', async () => {
    const { merchantId, storeId } = await shop();
    // Two lines inserted by one statement, so `created_at` is identical to the
    // microsecond. Without a tiebreak the card's "X + 1 more" could name either
    // product, and its tint — seeded off that line's id — would change colour
    // between refetches for no reason the seller could see.
    const customerId = (await freshCustomer()).id;
    await cart.addItem(customerId, {
      variant_id: (await variant(storeId, 10_000)).id,
      quantity: 1,
    });
    await cart.addItem(customerId, {
      variant_id: (await variant(storeId, 20_000)).id,
      quantity: 1,
    });
    const [order] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    await orders.confirmPayment(
      order!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );

    const first = await queue.detail(merchantId, order!.id);
    const second = await queue.detail(merchantId, order!.id);
    const page = await queue.list(merchantId);

    expect(first.items).toHaveLength(2);
    expect(first.items.map((i) => i.id)).toEqual(second.items.map((i) => i.id));
    expect(page.rows.find((r) => r.id === order!.id)?.items.map((i) => i.id)).toEqual(
      first.items.map((i) => i.id),
    );
  });

  it('finds the order behind a plan, which the schema only links the other way', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const planId = sale.order.customer_plan_id!;

    const found = await queue.ordersForPlans(merchantId, [planId]);

    // Without this the reserve list is a column of uuids and cedi amounts: a
    // `held_reserves` row knows its plan and nothing about what was sold.
    expect(found.get(planId)).toEqual({
      orderId: sale.order.id,
      orderNumber: sale.order.order_number,
      itemSummary: 'Ankara Wrap Dress',
    });
  });

  it('never resolves another seller’s plan to their order', async () => {
    const mine = await shop();
    const theirs = await shop();
    const theirSale = await sellFinanced(theirs.storeId, 40_000);

    const found = await queue.ordersForPlans(mine.merchantId, [theirSale.order.customer_plan_id!]);

    expect(found.size).toBe(0);
  });

  it('returns an empty map for no plans, without touching the database', async () => {
    const { merchantId } = await shop();
    expect((await queue.ordersForPlans(merchantId, [])).size).toBe(0);
  });

  it('says an unpaid order has not settled, rather than settled for nothing', async () => {
    const { merchantId, storeId } = await shop();
    const awaiting = await unpaid(storeId, 50_000);

    const s = (await queue.detail(merchantId, awaiting.order.id)).settlement;

    expect(s.bookedAt).toBeNull();
    expect(s.netPesewas).toBe(0);
    expect(s.feePesewas).toBe(0);
    // The rate is known from checkout even though nothing has been charged yet.
    expect(s.grossPesewas).toBe(50_000);
    expect(s.feeBps).toBe(500);
  });

  it('counts the deposit as one of the plan’s instalments', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);

    const plan = (await queue.detail(merchantId, sale.order.id)).plan!;

    // Four rows: a 40% deposit and three financed instalments of GHS 80.00.
    expect(plan.installments).toHaveLength(4);
    expect(plan.installments.map((i) => i.amount_due_pesewas)).toEqual([
      16_000, 8_000, 8_000, 8_000,
    ]);
    expect(plan.total_payable_pesewas).toBe(40_000);
    // And the column says three. "Pay in 4" is `number_of_installments: 3` plus
    // the deposit, which is why the sheet counts rows and never reads this.
    const [row] = await db
      .select({ n: schema.customer_plans.number_of_installments })
      .from(schema.customer_plans)
      .where(eq(schema.customer_plans.id, plan.id));
    expect(row?.n).toBe(3);
  });

  it('tracks what the plan has collected against the schedule that recorded it', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const before = (await queue.detail(merchantId, sale.order.id)).plan!;

    expect(before.paidCount).toBe(0);
    expect(before.collectedPesewas).toBe(0);
    expect(before.outstanding_pesewas).toBe(40_000);
    expect(before.nextDueDate).toBe(before.installments[0]!.due_date);

    const schedule = await plans.getSchedule(before.id);
    await plans.recordManualPayment(schedule[0]!.id, { reason: 'Deposit at the counter' }, ACTOR);

    const after = (await queue.detail(merchantId, sale.order.id)).plan!;

    expect(after.paidCount).toBe(1);
    expect(after.collectedPesewas).toBe(16_000);
    expect(after.outstanding_pesewas).toBe(24_000);
    // The next date money is expected moves onto the first financed instalment.
    expect(after.nextDueDate).toBe(after.installments[1]!.due_date);
    expect(after.status).toBe('active');
    expect(after.late).toBe(false);
  });

  it('skips a refunded instalment when it says what is due next', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const before = (await queue.detail(merchantId, sale.order.id)).plan!;
    const schedule = await plans.getSchedule(before.id);
    await db
      .update(schema.installment_schedule)
      .set({ status: 'refunded', amount_paid_pesewas: 0 })
      .where(eq(schema.installment_schedule.id, schedule[0]!.id));

    const after = (await queue.detail(merchantId, sale.order.id)).plan!;
    expect(after.nextDueDate).toBe(after.installments[1]!.due_date);
  });

  it('derives lateness from the schedule, because a plan has no late status', async () => {
    const { merchantId, storeId } = await shop();
    // Activated two months ago, so every row is past its grace date. Escalation
    // is a global sweep, and this is what keeps it to this plan: every other
    // plan in the file starts today and its grace has not expired.
    const sale = await sellFinanced(storeId, 40_000, daysAgo(60));
    expect(await collections.escalateGraceExpired(new Date(), ACTOR)).toBe(4);

    const plan = (await queue.detail(merchantId, sale.order.id)).plan!;

    expect(plan.late).toBe(true);
    // `customer_plans.status` stays 'active' through arrears — the schedule is
    // the only place lateness exists, which is why it is read off it.
    expect(plan.status).toBe('active');
    expect(plan.installments.every((i) => i.status === 'overdue')).toBe(true);
  });

  /**
   * An order's delivery address is a fact about that order.
   *
   * It used to be a live read of `addresses` through `shipping_address_id`, so
   * the buyer owned the seller's copy of it after the sale: editing a saved
   * address rewrote the delivery block of every past order pointing at it, and
   * deleting one blanked it outright — `ON DELETE SET NULL` plus no snapshot
   * meant the seller lost recipient, phone and city for an order that might
   * still be sitting in `fulfilling`.
   *
   * Neither was reachable from a client only because no client offered edit or
   * delete. The address book screen is what makes them reachable, so these two
   * go in with the snapshot rather than after it.
   */
  async function courierOrder(customerId: string, storeId: string, addressId: string) {
    // The harness truncates `delivery_zones`, so the migration's seeded
    // national row is gone by the time a spec runs and a courier checkout has
    // nothing to price against. One national fallback is enough here: these
    // two tests are about the address surviving, not about the rate.
    await db
      .insert(schema.delivery_zones)
      .values({ region: null, city: null, fee_pesewas: 2_000, eta_min_days: 2, eta_max_days: 5 })
      .onConflictDoNothing();
    const v = await variant(storeId, 25_000);
    await cart.addItem(customerId, { variant_id: v.id, quantity: 1 });
    const [order] = await orders.checkout(
      customerId,
      { payment_type: 'full', fulfilment_method: 'courier', shipping_address_id: addressId },
      ACTOR,
    );
    await orders.confirmPayment(
      order!.id,
      { provider_reference: `ps_${order!.id.slice(0, 8)}` },
      ACTOR,
    );
    return order!;
  }

  it('keeps the address the order was placed to when the buyer edits theirs', async () => {
    const { merchantId, storeId } = await shop();
    const customer = await freshCustomer();
    const address = await addresses.create(customer.id, {
      recipient: 'Ama Mensah',
      phone: '0240000002',
      region: 'Greater Accra',
      city: 'Accra',
      area: 'Osu',
    });
    const order = await courierOrder(customer.id, storeId, address.id);

    // The buyer moves house and corrects their address book.
    await addresses.update(customer.id, address.id, { city: 'Kumasi', area: 'Asokwa' });

    const detail = await queue.detail(merchantId, order.id);
    expect(detail.delivery).toMatchObject({ city: 'Accra', area: 'Osu' });
  });

  it('keeps it when the buyer deletes the address altogether', async () => {
    const { merchantId, storeId } = await shop();
    const customer = await freshCustomer();
    const address = await addresses.create(customer.id, {
      recipient: 'Kofi Asante',
      phone: '0240000003',
      region: 'Ashanti',
      city: 'Kumasi',
      landmark: 'Opposite the chemist',
    });
    const order = await courierOrder(customer.id, storeId, address.id);

    await addresses.remove(customer.id, address.id);

    // `ON DELETE SET NULL` still nulls the pointer — that part is unchanged.
    const [row] = await db
      .select({ id: schema.orders.shipping_address_id })
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(row?.id).toBeNull();

    // But the seller can still put it on a van.
    const detail = await queue.detail(merchantId, order.id);
    expect(detail.delivery).toMatchObject({
      recipient: 'Kofi Asante',
      phone: '0240000003',
      region: 'Ashanti',
      city: 'Kumasi',
      landmark: 'Opposite the chemist',
    });
  });

  it('resolves a courier order to the address it is going to', async () => {
    const { merchantId, storeId } = await shop();
    const customer = await freshCustomer();
    const v = await variant(storeId, 25_000);
    // The harness truncates delivery_zones, so the migration's seeded rates are
    // gone by the time a spec runs — the zone under test is explicit.
    await db.insert(schema.delivery_zones).values({
      region: 'Greater Accra',
      city: 'Accra',
      fee_pesewas: 1_500,
      eta_min_days: 1,
      eta_max_days: 3,
    });
    const address = await addresses.create(customer.id, {
      recipient: 'Ama Mensah',
      phone: '0240000002',
      region: 'Greater Accra',
      city: 'Accra',
      area: 'Osu',
      landmark: 'Behind the Total station',
      ghanapost_gps: 'GA-183-7192',
    });
    await cart.addItem(customer.id, { variant_id: v.id, quantity: 1 });
    const [order] = await orders.checkout(
      customer.id,
      { payment_type: 'full', fulfilment_method: 'courier', shipping_address_id: address.id },
      ACTOR,
    );
    await orders.confirmPayment(order!.id, { provider_reference: 'ps_courier' }, ACTOR);

    const detail = await queue.detail(merchantId, order!.id);

    expect(detail.delivery).toMatchObject({
      method: 'courier',
      recipient: 'Ama Mensah',
      phone: '0240000002',
      region: 'Greater Accra',
      city: 'Accra',
      area: 'Osu',
      landmark: 'Behind the Total station',
      ghanapost_gps: 'GA-183-7192',
      hub_name: null,
      hub_detail: null,
    });
    // The commission is on the goods, not the delivery: GHS 250.00 less 5% is
    // GHS 237.50, and the GHS 15.00 delivery passes to the seller whole — GHS
    // 252.50. (It was GHS 251.75 while commission was taken on the total.)
    expect(detail.total_pesewas).toBe(26_500);
    expect(detail.settlement.netPesewas).toBe(25_250);
  });

  it('resolves a pickup order to the hub it will be collected from', async () => {
    const { merchantId, storeId } = await shop();
    const customer = await freshCustomer();
    const v = await variant(storeId, 25_000);
    // Pickup hubs are reference data the migrations do not seed.
    const hub = (
      await db
        .insert(schema.pickup_hubs)
        .values({
          name: 'Circle MoMo Hub',
          region: 'Greater Accra',
          city: 'Accra',
          area: 'Circle',
          detail: 'Kwame Nkrumah Ave · open till 8pm',
        })
        .returning()
    )[0]!;
    await cart.addItem(customer.id, { variant_id: v.id, quantity: 1 });
    const [order] = await orders.checkout(
      customer.id,
      { payment_type: 'full', fulfilment_method: 'pickup', pickup_hub_id: hub.id },
      ACTOR,
    );
    await orders.confirmPayment(order!.id, { provider_reference: 'ps_pickup' }, ACTOR);

    const detail = await queue.detail(merchantId, order!.id);

    expect(detail.delivery).toEqual({
      method: 'pickup',
      recipient: null,
      phone: null,
      region: 'Greater Accra',
      city: 'Accra',
      area: 'Circle',
      landmark: null,
      ghanapost_gps: null,
      hub_name: 'Circle MoMo Hub',
      hub_detail: 'Kwame Nkrumah Ave · open till 8pm',
    });
    // Collection is free, so the whole total is the goods.
    expect(detail.shipping_pesewas).toBe(0);
  });

  it('hands over the buyer’s name and phone, and nothing else about them', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 18_000);

    const detail = await queue.detail(merchantId, sale.order.id);

    expect(detail.buyer).toEqual({
      id: sale.customer.id,
      name: sale.customer.name,
      phone: sale.customer.phone,
    });
    // A `select()` on `customers` would hand the seller the buyer's email and
    // whatever column is added next; this pins the projection to three fields.
    expect(Object.keys(detail.buyer!).sort()).toEqual(['id', 'name', 'phone']);
  });

  it('returns the order’s own history, oldest first', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellOutright(storeId, 20_000);
    await fulfilment.markShipped(sale.order.id, { courier_name: 'Swift Riders' }, ACTOR, {
      merchantId,
    });
    await fulfilment.markDelivered(sale.order.id, {}, ACTOR, { merchantId });

    const events = (await queue.detail(merchantId, sale.order.id)).events;

    expect(events[0]?.event_type).toBe('order.created');
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'order.created',
        'order.paid',
        'order.fulfilling',
        'order.shipped',
        'order.delivered',
      ]),
    );
    // Shipping writes `order.fulfilling` and `order.shipped` in one transaction
    // and they share an `occurred_at` to the microsecond, so the guarantee is
    // non-decreasing rather than a fixed sequence.
    const times = events.map((e) => e.occurred_at);
    expect(times).toEqual([...times].sort());
    expect(events.at(-1)?.event_type).toBe('order.delivered');
  });

  it('answers another seller’s order the same way as one that does not exist', async () => {
    const mine = await shop();
    const theirs = await shop();
    const sale = await sellOutright(mine.storeId, 11_000);

    // Not found, not forbidden: a 403 confirms the order exists, which turns
    // uuid enumeration into a leak of who is selling what to whom.
    await expect(queue.detail(theirs.merchantId, sale.order.id)).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
    await expect(queue.detail(mine.merchantId, randomUUID())).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
    expect((await queue.list(theirs.merchantId)).total).toBe(0);
  });
});
