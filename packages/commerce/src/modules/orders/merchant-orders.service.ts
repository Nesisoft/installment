import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { PLAN_ACCRUAL_TX_PREFIX, reserveReleaseDate } from '@installment/core';
import { schema, type Database } from '@installment/db';
import { OrderNotFoundError } from './errors';
import { ORDER_PAYMENT_TX_PREFIX, type Order, type OrderItem } from './orders.service';
import type { OrderEvent } from '../fulfilment/fulfilment.service';
import { ORDER_RETURN_TX_PREFIX } from '../returns/returns.service';

const o = schema.orders;
const oi = schema.order_items;
const cust = schema.customers;
const addr = schema.addresses;
const hubs = schema.pickup_hubs;
const cp = schema.customer_plans;
const isch = schema.installment_schedule;
const hr = schema.held_reserves;
const oe = schema.order_events;

/**
 * The buyer, as the seller is allowed to see them.
 *
 * Name and phone and nothing else. A seller needs to address a parcel and ring
 * a doorbell; they do not need the buyer's email, date of birth, Ghana Card,
 * credit standing or the other orders they have placed across the marketplace.
 * That is why this is a hand-picked projection rather than the `customers` row
 * — a `select()` here would leak the lot the first time somebody added a column.
 */
export interface MerchantOrderBuyer {
  id: string;
  name: string;
  phone: string;
}

/**
 * Where the order is going, resolved.
 *
 * `orders.shipping_address_id` is `ON DELETE SET NULL`, so an order that has
 * already shipped can lose its address — every field is therefore nullable and
 * the screen has to cope. For a pickup order the address is null by design and
 * the hub is what matters.
 */
export interface MerchantOrderDelivery {
  method: string;
  recipient: string | null;
  phone: string | null;
  region: string | null;
  city: string | null;
  area: string | null;
  landmark: string | null;
  ghanapost_gps: string | null;
  hub_name: string | null;
  hub_detail: string | null;
}

/**
 * What this one order was worth to the seller, read out of the ledger.
 *
 * Never recomputed from rates. `commission_bps` on the order and `mdr_bps` on
 * the plan say what SHOULD have been charged; the ledger says what was, and the
 * payout run pays against the ledger. Where the two disagree the ledger is
 * right and the seller needs to see the number they will actually be paid.
 *
 * `bookedAt` is null for an order that has not been paid for or financed yet —
 * there is no settlement, as opposed to a settlement of zero.
 */
export interface MerchantOrderSettlement {
  /** The order total the books settled against. */
  grossPesewas: number;
  /** Credited to `revenue`: marketplace commission outright, MDR on a plan. */
  feePesewas: number;
  feeLabel: 'commission' | 'mdr';
  /** The rate on the row that charged it, for the "4%" beside the figure. */
  feeBps: number | null;
  /** Credited to `reserve_held`. Always 0 on an outright sale. */
  reservePesewas: number;
  reserveBps: number | null;
  /** Credited to `merchant_payable` — the figure the payout run pays. */
  netPesewas: number;
  bookedAt: string | null;
  /**
   * Reserve still held against this order's plan, net of what has been released
   * and of anything a default consumed. Live, so it shrinks as the reserve
   * matures — which is why it is not `reservePesewas` minus arithmetic.
   */
  reserveOutstandingPesewas: number;
  /**
   * The earliest date the model's policy allows this reserve to be released, or
   * `null` while the plan is still running.
   *
   * The POLICY's date, not the trigger's. `held_reserves` stamps when the plan
   * completed or defaulted; the buffer that turns that into a release date is
   * per business model — 14 days after completion for bnpl and hybrid, 7 after
   * delivery for layaway, immediately for rent_to_own — and lives in the
   * settlement engine. Handing the trigger date to a client that printed it as
   * the release date would tell a seller their money was free a fortnight
   * early, so this runs the same `reserveReleaseDate()` the release sweep does.
   *
   * Null is the honest answer, not a missing one: the clock starts at
   * completion or default, and until one of those has happened there is no date
   * to show. A projected date would be a promise the system has not made.
   */
  reserveReleasesAt: string | null;
}

export interface MerchantOrderInstallment {
  sequence_number: number;
  due_date: string;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  status: string;
  paid_at: string | null;
}

/**
 * The credit plan behind a financed order, from the seller's side.
 *
 * `installments.length` is the number of payments the customer makes, deposit
 * included. `number_of_installments` on the plan EXCLUDES the deposit, so a
 * "Pay in 4" plan has that field set to 3 and four rows here — count the rows.
 */
export interface MerchantOrderPlan {
  id: string;
  status: string;
  business_model: string;
  mdr_bps: number;
  reserve_bps: number;
  total_payable_pesewas: number;
  outstanding_pesewas: number;
  collectedPesewas: number;
  paidCount: number;
  /** Every payment on the plan, deposit first. */
  installments: MerchantOrderInstallment[];
  /** The next date money is expected, or null once nothing is outstanding. */
  nextDueDate: string | null;
  /** True when any row has fallen past its grace period. */
  late: boolean;
}

export interface MerchantOrderRow extends Order {
  items: OrderItem[];
  buyer_name: string | null;
  buyer_phone: string | null;
  /**
   * What the ledger has credited the merchant for this order so far, or null
   * where nothing has been booked. Null, not 0: an order awaiting payment has
   * not settled for nothing, it has not settled.
   */
  settled_pesewas: number | null;
}

export interface MerchantOrderDetail extends Order {
  items: OrderItem[];
  buyer: MerchantOrderBuyer | null;
  delivery: MerchantOrderDelivery;
  settlement: MerchantOrderSettlement;
  plan: MerchantOrderPlan | null;
  /** The order's own history, oldest first. */
  events: OrderEvent[];
}

/**
 * The buckets the seller's queue is filtered by.
 *
 * Not order statuses — a mapping onto them, because the queue's vocabulary and
 * the state machine's are different. `new` is two statuses (an order is the
 * seller's the moment it is paid for, outright or on an approved plan), and
 * `confirmed` is `fulfilling`, because "Confirm order" is what the seller calls
 * pressing the button that writes it. There is no `confirmed` status and this
 * is where that is reconciled, once, rather than in each screen.
 */
export const MERCHANT_ORDER_BUCKETS = {
  new: ['paid', 'financing_active'],
  confirmed: ['fulfilling'],
  shipped: ['shipped'],
  delivered: ['delivered'],
  completed: ['completed'],
} as const;

export type MerchantOrderBucket = keyof typeof MERCHANT_ORDER_BUCKETS;

export function isMerchantOrderBucket(value: string): value is MerchantOrderBucket {
  return Object.prototype.hasOwnProperty.call(MERCHANT_ORDER_BUCKETS, value);
}

export type MerchantOrderCounts = Record<MerchantOrderBucket | 'all', number>;

/**
 * `+1` on a credit, `-1` on a debit, so a sum is a net balance.
 *
 * Every figure this service reports has to survive a reversal. A refund or an
 * approved return books the compensating entries under the SAME transaction id
 * — the ledger is append-only, so undoing means posting the opposite — and a
 * sum over credits alone would keep reporting the original settlement to a
 * seller whose money has already been clawed back: a failure state rendered as
 * a successful payout.
 */
const SIGN = sql`CASE WHEN le.direction = 'credit' THEN 1 ELSE -1 END`;

interface PlanOrderRow {
  plan_id: string;
  order_id: string;
  order_number: string;
  item_title: string | null;
}

interface LedgerAggregateRow {
  order_id: string;
  net: string;
  fee: string;
  reserve: string;
  booked_at: string | null;
}

/**
 * The seller's view of their own orders.
 *
 * Split out of `OrdersService`, which owns the writes and is already long, and
 * because everything here is a projection built for one screen: the queue and
 * the order sheet in the merchant app. Nothing in it mutates.
 *
 * Every query puts `merchant_id` in the WHERE clause rather than checking after
 * the read, so another seller's order answers 404 and not 403 — a 403 confirms
 * the order exists, which turns uuid enumeration into a leak of who is selling
 * what to whom.
 */
export class MerchantOrdersService {
  constructor(private readonly db: Database) {}

  /**
   * A page of the queue, with the buyer and what the order settled for.
   *
   * The buyer join and the ledger aggregate are two extra queries for the whole
   * page, not two per row. The alternative the design implies — resolving the
   * settlement per card — is fifty requests for a page of twenty-five, on a
   * connection where that is the difference between a screen and a spinner.
   */
  async list(
    merchantId: string,
    opts: { bucket?: MerchantOrderBucket; limit?: number; offset?: number } = {},
  ): Promise<{ rows: MerchantOrderRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const statuses = opts.bucket ? MERCHANT_ORDER_BUCKETS[opts.bucket] : null;
    const where = statuses
      ? and(eq(o.merchant_id, merchantId), inArray(o.status, [...statuses]))
      : eq(o.merchant_id, merchantId);

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(o)
      .where(where);

    const rows = await this.db
      .select({ order: o, buyer_name: buyerName, buyer_phone: cust.phone })
      .from(o)
      .leftJoin(cust, eq(cust.id, o.customer_id))
      .where(where)
      // `placed_at` first: the queue is ordered by when an order became the
      // seller's, and an abandoned cart's `created_at` would float it above a
      // real order placed a minute ago. Nulls last, then `created_at` as the
      // tiebreak so unplaced rows still have a stable order.
      .orderBy(sql`${o.placed_at} DESC NULLS LAST`, desc(o.created_at))
      .limit(limit)
      .offset(offset);
    if (rows.length === 0) return { rows: [], total: count };

    const orderIds = rows.map((r) => r.order.id);
    const [itemsByOrder, settledByOrder] = await Promise.all([
      this.itemsFor(orderIds),
      this.settledFor(merchantId, orderIds),
    ]);

    return {
      rows: rows.map((r) => ({
        ...r.order,
        items: itemsByOrder.get(r.order.id) ?? [],
        buyer_name: r.buyer_name,
        buyer_phone: r.buyer_phone,
        settled_pesewas: settledByOrder.get(r.order.id)?.netPesewas ?? null,
      })),
      total: count,
    };
  }

  /**
   * The order behind each of several credit plans.
   *
   * The link only runs one way in the schema: `orders.customer_plan_id` points
   * at the plan, and the plan knows nothing about the order — no order id, no
   * product, no title. So a screen built on plans or on reserves (both of which
   * are keyed by plan) has no way to say WHICH SALE it is looking at, and shows
   * the seller a list of uuids and cedi amounts.
   *
   * One query for the whole page. `DISTINCT ON` because the column is not
   * unique — nothing stops two orders pointing at one plan, and picking the
   * oldest keeps the answer stable rather than letting it flip between reads.
   */
  async ordersForPlans(
    merchantId: string,
    planIds: string[],
  ): Promise<Map<string, { orderId: string; orderNumber: string; itemSummary: string | null }>> {
    const out = new Map<
      string,
      { orderId: string; orderNumber: string; itemSummary: string | null }
    >();
    if (planIds.length === 0) return out;

    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (ord.customer_plan_id)
             ord.customer_plan_id AS plan_id,
             ord.id::text         AS order_id,
             ord.order_number     AS order_number,
             first_item.title     AS item_title
      FROM orders ord
      LEFT JOIN LATERAL (
        SELECT oi.title
        FROM order_items oi
        WHERE oi.order_id = ord.id
        ORDER BY oi.created_at, oi.id
        LIMIT 1
      ) first_item ON TRUE
      WHERE ord.merchant_id = ${merchantId}
        AND ord.customer_plan_id IN (${sql.join(
          planIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      ORDER BY ord.customer_plan_id, ord.created_at
    `);

    for (const r of rows.rows as unknown as PlanOrderRow[]) {
      out.set(r.plan_id, {
        orderId: r.order_id,
        orderNumber: r.order_number,
        itemSummary: r.item_title,
      });
    }
    return out;
  }

  /** How many orders sit in each bucket. One query, not six. */
  async counts(merchantId: string): Promise<MerchantOrderCounts> {
    const rows = await this.db
      .select({ status: o.status, count: sql<number>`count(*)::int` })
      .from(o)
      .where(eq(o.merchant_id, merchantId))
      .groupBy(o.status);

    const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
    const counts = { all: 0 } as MerchantOrderCounts;
    for (const [bucket, statuses] of Object.entries(MERCHANT_ORDER_BUCKETS)) {
      counts[bucket as MerchantOrderBucket] = statuses.reduce(
        (n, status) => n + (byStatus.get(status) ?? 0),
        0,
      );
    }
    // Every order the seller has, including the ones no bucket shows —
    // cancelled, declined, returned. "All" that quietly excluded them would not
    // reconcile with the list "All" actually renders.
    counts.all = rows.reduce((n, r) => n + Number(r.count), 0);
    return counts;
  }

  /** One order, with everything the order sheet draws. */
  async detail(merchantId: string, orderId: string): Promise<MerchantOrderDetail> {
    const [row] = await this.db
      .select({ order: o, buyer_name: buyerName, buyer_phone: cust.phone })
      .from(o)
      .leftJoin(cust, eq(cust.id, o.customer_id))
      .where(and(eq(o.id, orderId), eq(o.merchant_id, merchantId)))
      .limit(1);
    if (!row) throw new OrderNotFoundError(orderId);
    const order = row.order;

    const [items, delivery, settlement, plan, events] = await Promise.all([
      this.itemsFor([orderId]).then((m) => m.get(orderId) ?? []),
      this.deliveryFor(order),
      this.settlementFor(merchantId, order),
      order.customer_plan_id ? this.planFor(order.customer_plan_id) : Promise.resolve(null),
      this.db.select().from(oe).where(eq(oe.order_id, orderId)).orderBy(asc(oe.occurred_at)),
    ]);

    return {
      ...order,
      items,
      buyer: row.buyer_name
        ? { id: order.customer_id, name: row.buyer_name, phone: row.buyer_phone ?? '' }
        : null,
      delivery,
      settlement,
      plan,
      events,
    };
  }

  // ----------------------------------------------------------------- internal

  private async itemsFor(orderIds: string[]): Promise<Map<string, OrderItem[]>> {
    const rows = await this.db
      .select()
      .from(oi)
      .where(inArray(oi.order_id, orderIds))
      // `id` as the tiebreak because every line on one order is inserted in the
      // same statement and shares `created_at` to the microsecond. Without it
      // "Ankara Wrap Dress + 2 more" could name a different line on the next
      // refetch, and the card's tint — seeded off that line's id — would change
      // colour under the seller for no reason.
      .orderBy(asc(oi.created_at), asc(oi.id));
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of rows) {
      const bucket = byOrder.get(item.order_id);
      if (bucket) bucket.push(item);
      else byOrder.set(item.order_id, [item]);
    }
    return byOrder;
  }

  private async deliveryFor(order: Order): Promise<MerchantOrderDelivery> {
    const empty: MerchantOrderDelivery = {
      method: order.fulfilment_method,
      recipient: null,
      phone: null,
      region: null,
      city: null,
      area: null,
      landmark: null,
      ghanapost_gps: null,
      hub_name: null,
      hub_detail: null,
    };

    if (order.fulfilment_method === 'pickup') {
      if (!order.pickup_hub_id) return empty;
      const [hub] = await this.db
        .select()
        .from(hubs)
        .where(eq(hubs.id, order.pickup_hub_id))
        .limit(1);
      if (!hub) return empty;
      return {
        ...empty,
        region: hub.region,
        city: hub.city,
        area: hub.area,
        hub_name: hub.name,
        hub_detail: hub.detail,
      };
    }

    if (!order.shipping_address_id) return empty;
    const [a] = await this.db
      .select()
      .from(addr)
      .where(eq(addr.id, order.shipping_address_id))
      .limit(1);
    if (!a) return empty;
    return {
      ...empty,
      recipient: a.recipient,
      phone: a.phone,
      region: a.region,
      city: a.city,
      area: a.area,
      landmark: a.landmark,
      ghanapost_gps: a.ghanapost_gps,
    };
  }

  /**
   * The ledger's own account of what several orders paid the merchant.
   *
   * One query for the page. An order's credits live under one of two
   * transaction id shapes — `order-payment:{orderId}` for an outright sale and
   * `accrue:{planId}:{trigger}` for each payout trigger on a plan — so the join
   * reaches both and sums, because a model with per-instalment triggers fires
   * several.
   */
  private async settledFor(
    merchantId: string,
    orderIds: string[],
  ): Promise<
    Map<
      string,
      { netPesewas: number; feePesewas: number; reservePesewas: number; bookedAt: string | null }
    >
  > {
    const rows = await this.db.execute(sql`
      SELECT ord.id                                                        AS order_id,
             coalesce(sum(le.amount_pesewas * ${SIGN})
               FILTER (WHERE le.account_type = 'merchant_payable'), 0)::text  AS net,
             coalesce(sum(le.amount_pesewas * ${SIGN})
               FILTER (WHERE le.account_type = 'revenue'), 0)::text           AS fee,
             coalesce(sum(le.amount_pesewas * ${SIGN})
               FILTER (WHERE le.account_type = 'reserve_held'), 0)::text      AS reserve,
             min(le.occurred_at) FILTER (WHERE le.direction = 'credit')::text AS booked_at
      FROM orders ord
      JOIN ledger_entries le
        ON (
             le.transaction_id = ${ORDER_PAYMENT_TX_PREFIX} || ord.id::text
             OR (ord.customer_plan_id IS NOT NULL
                 AND le.transaction_id LIKE ${PLAN_ACCRUAL_TX_PREFIX} || ord.customer_plan_id::text || ':%')
             -- The reversal an approved return books. It is a SEPARATE
             -- transaction, not more entries under the original one, because
             -- the ledger is append-only -- so a sum that reached only the
             -- accrual would go on reporting a payout the seller no longer has.
             OR le.transaction_id IN (
                  SELECT ${ORDER_RETURN_TX_PREFIX} || r.id::text
                  FROM order_returns r
                  WHERE r.order_id = ord.id
                )
           )
      WHERE ord.merchant_id = ${merchantId}
        AND ord.id IN (${sql.join(
          orderIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY ord.id
    `);

    const out = new Map<
      string,
      { netPesewas: number; feePesewas: number; reservePesewas: number; bookedAt: string | null }
    >();
    for (const r of rows.rows as unknown as LedgerAggregateRow[]) {
      out.set(r.order_id, {
        netPesewas: Number(r.net),
        feePesewas: Number(r.fee),
        reservePesewas: Number(r.reserve),
        bookedAt: r.booked_at,
      });
    }
    return out;
  }

  private async settlementFor(merchantId: string, order: Order): Promise<MerchantOrderSettlement> {
    const [booked, reserve, planRates] = await Promise.all([
      this.settledFor(merchantId, [order.id]).then((m) => m.get(order.id) ?? null),
      order.customer_plan_id ? this.reserveFor(order.customer_plan_id) : Promise.resolve(null),
      order.customer_plan_id ? this.ratesFor(order.customer_plan_id) : Promise.resolve(null),
    ]);

    const financed = order.payment_type === 'installment';
    return {
      grossPesewas: order.total_pesewas,
      feePesewas: booked?.feePesewas ?? 0,
      feeLabel: financed ? 'mdr' : 'commission',
      // The rate that actually charged it: frozen onto the plan at activation
      // for a financed order, and onto the order at checkout for an outright
      // one. Neither is `merchants.default_*_bps`, which the settlement path
      // does not read.
      feeBps: financed ? (planRates?.mdr_bps ?? null) : order.commission_bps,
      reservePesewas: booked?.reservePesewas ?? 0,
      reserveBps: financed ? (planRates?.reserve_bps ?? null) : null,
      netPesewas: booked?.netPesewas ?? 0,
      bookedAt: booked?.bookedAt ?? null,
      reserveOutstandingPesewas: reserve?.outstanding ?? 0,
      reserveReleasesAt: reserve?.releasesAt ?? null,
    };
  }

  private async ratesFor(planId: string): Promise<{ mdr_bps: number; reserve_bps: number } | null> {
    const [row] = await this.db
      .select({ mdr_bps: cp.mdr_bps, reserve_bps: cp.reserve_bps })
      .from(cp)
      .where(eq(cp.id, planId))
      .limit(1);
    return row ?? null;
  }

  /**
   * What is still held against a plan, and when the policy lets it move.
   *
   * The date comes from `reserveReleaseDate`, the same pure function the
   * nightly release sweep runs, so the seller reads the date their money will
   * actually arrive on rather than the date the clock started. A plan with
   * several reserve rows reports the LAST of them: the seller is waiting on all
   * of it, and quoting the earliest would promise the whole balance sooner than
   * any of it moves.
   */
  private async reserveFor(
    planId: string,
  ): Promise<{ outstanding: number; releasesAt: string | null }> {
    const rows = await this.db.select().from(hr).where(eq(hr.customer_plan_id, planId));
    let outstanding = 0;
    let releasesAt: Date | null = null;
    for (const r of rows) {
      outstanding += r.amount_pesewas - r.released_amount_pesewas - r.consumed_for_default_pesewas;
      const releaseAt = reserveReleaseDate(r);
      if (releaseAt && (!releasesAt || releaseAt > releasesAt)) releasesAt = releaseAt;
    }
    return {
      outstanding: Math.max(0, outstanding),
      releasesAt: releasesAt ? releasesAt.toISOString() : null,
    };
  }

  private async planFor(planId: string): Promise<MerchantOrderPlan | null> {
    const [plan] = await this.db.select().from(cp).where(eq(cp.id, planId)).limit(1);
    if (!plan) return null;

    const schedule = await this.db
      .select()
      .from(isch)
      .where(eq(isch.customer_plan_id, planId))
      .orderBy(asc(isch.sequence_number));

    const installments = schedule.map((s) => ({
      sequence_number: s.sequence_number,
      due_date: s.due_date,
      amount_due_pesewas: s.amount_due_pesewas,
      amount_paid_pesewas: s.amount_paid_pesewas,
      status: s.status,
      paid_at: s.paid_at,
    }));

    const collectedPesewas = installments.reduce((n, i) => n + i.amount_paid_pesewas, 0);
    const paidCount = installments.filter((i) => i.status === 'paid').length;
    const next = installments.find((i) => i.status !== 'paid' && i.status !== 'waived');

    return {
      id: plan.id,
      status: plan.status,
      business_model: plan.business_model,
      mdr_bps: plan.mdr_bps,
      reserve_bps: plan.reserve_bps,
      total_payable_pesewas: plan.total_payable_pesewas,
      outstanding_pesewas: plan.outstanding_pesewas,
      collectedPesewas,
      paidCount,
      installments,
      nextDueDate: next?.due_date ?? null,
      // There is no late plan status — `customer_plans.status` stays 'active'
      // through arrears — so lateness is read off the schedule, which is the
      // only place it exists.
      late: installments.some(
        (i) => i.status === 'overdue' || i.status === 'in_collections' || i.status === 'defaulted',
      ),
    };
  }
}

/**
 * `first_name last_name`, trimmed, or null when the join found nobody.
 *
 * Built in SQL so the page's names come back with the page rather than needing
 * a second pass, and `concat_ws` rather than `||` because a null part in a
 * concatenation makes the whole string null.
 */
const buyerName = sql<
  string | null
>`nullif(trim(concat_ws(' ', ${cust.first_name}, ${cust.last_name})), '')`;
