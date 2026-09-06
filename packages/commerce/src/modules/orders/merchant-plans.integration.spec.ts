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
import { PlanNotFoundError } from './errors';
import { MerchantOrdersService } from './merchant-orders.service';
import { MerchantPlansService } from './merchant-plans.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('MerchantPlansService (integration)', () => {
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
  const cart = new CartService(db);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const queue = new MerchantOrdersService(db);
  const merchantPlans = new MerchantPlansService(db, queue);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

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
   * `number_of_installments` is 3 and the generated schedule has FOUR rows —
   * the deposit is one of them. Every count on the seller's plan screens is
   * taken off the rows for that reason.
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

  /**
   * The reachability proof for the seller's plan screens.
   *
   * Nothing here inserts a plan or a schedule row. Every plan is produced by
   * driving a real instalment checkout through `OrdersService` and the engine's
   * application decision, so if `orders.customer_plan_id` stopped being written,
   * or the schedule generator changed shape, or the accrual transaction id was
   * renamed, this file fails rather than quietly reporting zeroes.
   */
  it('brings the sale, the customer and the schedule back with each plan', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);

    const { rows, total } = await merchantPlans.list(merchantId);

    expect(total).toBe(1);
    const row = rows[0]!;
    // None of this is on `customer_plans`: the plan knows no product, no order
    // and no name, because the link runs the other way.
    expect(row.orderNumber).toBe(sale.order.order_number);
    expect(row.orderId).toBe(sale.order.id);
    expect(row.itemSummary).toBe('Ankara Wrap Dress');
    expect(row.customerName).toBe(sale.customer.name);
    expect(row.orderAmountPesewas).toBe(40_000);
  });

  it('counts the deposit as one of the plan’s payments', async () => {
    const { merchantId, storeId } = await shop();
    await sellFinanced(storeId, 40_000);

    const row = (await merchantPlans.list(merchantId)).rows[0]!;

    // "Pay in 4" is a deposit plus three financed instalments:
    // `number_of_installments` is 3 and the schedule has FOUR rows. A card
    // built on the column would tell the seller the customer owes one payment
    // fewer than they do.
    expect(row.installmentCount).toBe(4);
  });

  it('sums what has been collected off the schedule, not off the plan row', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const planId = sale.order.customer_plan_id!;

    const before = (await merchantPlans.list(merchantId)).rows[0]!;
    const depositPaid = before.collectedPesewas;

    // Mark the next instalment paid the way a collection would.
    const schedule = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.customer_plan_id, planId))
      .orderBy(schema.installment_schedule.sequence_number);
    const next = schedule.find((s) => s.status !== 'paid')!;
    await db
      .update(schema.installment_schedule)
      .set({ status: 'paid', amount_paid_pesewas: next.amount_due_pesewas })
      .where(eq(schema.installment_schedule.id, next.id));

    const after = (await merchantPlans.list(merchantId)).rows[0]!;

    expect(after.collectedPesewas).toBe(depositPaid + next.amount_due_pesewas);
    expect(after.paidCount).toBe(before.paidCount + 1);
    // The next due date moves with it.
    expect(after.nextDueDate).not.toBe(before.nextDueDate);
  });

  it('derives lateness from the schedule, because a plan in arrears is still active', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    const planId = sale.order.customer_plan_id!;

    expect((await merchantPlans.list(merchantId)).rows[0]!.late).toBe(false);
    expect((await merchantPlans.counts(merchantId)).late).toBe(0);

    const schedule = await db
      .select()
      .from(schema.installment_schedule)
      .where(eq(schema.installment_schedule.customer_plan_id, planId))
      .orderBy(schema.installment_schedule.sequence_number);
    await db
      .update(schema.installment_schedule)
      .set({ status: 'overdue' })
      .where(eq(schema.installment_schedule.id, schedule[1]!.id));

    const [row] = (await merchantPlans.list(merchantId, { bucket: 'late' })).rows;
    const counts = await merchantPlans.counts(merchantId);

    expect(row?.id).toBe(planId);
    expect(row?.late).toBe(true);
    expect(counts.late).toBe(1);
    // And the plan is STILL active — `customer_plans.status` has no late
    // member, which is the whole reason `late` is a derived bucket.
    expect(row?.status).toBe('active');
    expect(counts.active).toBe(1);
  });

  it('counts every plan under All, including ones no other chip shows', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);
    await sellFinanced(storeId, 20_000);
    await db
      .update(schema.customer_plans)
      .set({ status: 'cancelled' })
      .where(eq(schema.customer_plans.id, sale.order.customer_plan_id!));

    const counts = await merchantPlans.counts(merchantId);

    expect(counts.all).toBe(2);
    expect(counts.active).toBe(1);
    expect(counts.completed).toBe(0);
    expect((await merchantPlans.list(merchantId, { bucket: 'all' })).total).toBe(2);
  });

  it('reads what the ledger accrued on the plan, not the rate on the row', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);

    const detail = await merchantPlans.detail(merchantId, sale.order.customer_plan_id!);

    // bnpl: 4% MDR and 5% reserve, booked at approval.
    expect(detail.mdrBps).toBe(400);
    expect(detail.reserveBps).toBe(500);
    expect(detail.mdrPesewas).toBe(1_600);
    expect(detail.reserveWithheldPesewas).toBe(2_000);
    expect(detail.settledPesewas).toBe(36_400);
    // The three legs are the order, cut up — a breakdown that did not
    // reconcile would be worse than no breakdown.
    expect(detail.settledPesewas + detail.mdrPesewas + detail.reserveWithheldPesewas).toBe(
      detail.orderAmountPesewas,
    );
    expect(detail.reserveOutstandingPesewas).toBe(2_000);
    // Still running, so there is no release date to give.
    expect(detail.reserveReleasesAt).toBeNull();
  });

  it('returns the schedule oldest first, with the deposit as row one', async () => {
    const { merchantId, storeId } = await shop();
    const sale = await sellFinanced(storeId, 40_000);

    const detail = await merchantPlans.detail(merchantId, sale.order.customer_plan_id!);

    expect(detail.installments).toHaveLength(4);
    expect(detail.installments.map((i) => i.sequence_number)).toEqual([1, 2, 3, 4]);
    expect(detail.installments.map((i) => i.due_date)).toEqual(
      [...detail.installments.map((i) => i.due_date)].sort(),
    );
    // 40% down on the Pay-in-4 template.
    expect(detail.installments[0]?.amount_due_pesewas).toBe(16_000);
  });

  it('opens a plan past the first page, rather than only ones a page happens to hold', async () => {
    const { merchantId, storeId } = await shop();
    const first = await sellFinanced(storeId, 40_000);
    await sellFinanced(storeId, 20_000);
    await sellFinanced(storeId, 30_000);

    // The oldest plan is last by `created_at DESC`, so a detail implemented by
    // filtering one page would miss it the moment the catalogue outgrew a page.
    const page = await merchantPlans.list(merchantId, { limit: 1 });
    expect(page.rows.map((r) => r.id)).not.toContain(first.order.customer_plan_id!);

    const detail = await merchantPlans.detail(merchantId, first.order.customer_plan_id!);
    expect(detail.id).toBe(first.order.customer_plan_id!);
  });

  it('answers another seller’s plan the same way as one that does not exist', async () => {
    const mine = await shop();
    const theirs = await shop();
    const theirSale = await sellFinanced(theirs.storeId, 40_000);

    await expect(
      merchantPlans.detail(mine.merchantId, theirSale.order.customer_plan_id!),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
    await expect(merchantPlans.detail(mine.merchantId, randomUUID())).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    expect((await merchantPlans.list(mine.merchantId)).rows).toEqual([]);
  });

  it('reports nothing for a seller with no instalment sales', async () => {
    const { merchantId } = await shop();

    expect(await merchantPlans.list(merchantId)).toEqual({ rows: [], total: 0 });
    expect(await merchantPlans.counts(merchantId)).toEqual({
      active: 0,
      late: 0,
      completed: 0,
      all: 0,
    });
  });
});
