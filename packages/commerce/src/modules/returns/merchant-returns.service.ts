import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@installment/core';
import { schema, type Database } from '@installment/db';
import { ReturnNotFoundError } from './errors';
import { RETURN_STATUSES, type ReturnStatus } from './dto';

const ret = schema.order_returns;
const o = schema.orders;
const oi = schema.order_items;
const cust = schema.customers;

const buyerName = sql<
  string | null
>`nullif(trim(concat_ws(' ', ${cust.first_name}, ${cust.last_name})), '')`;

/**
 * The buckets the seller's returns queue is filtered by.
 *
 * `RETURN_STATUSES` one-for-one plus `all`, because unlike the order queue
 * there is no re-grouping to do: a return is requested, approved, rejected or
 * cancelled, and each of those is already a thing a seller thinks about
 * separately. `requested` leads because it is the only one that wants anything
 * from them.
 */
export const MERCHANT_RETURN_BUCKETS = [...RETURN_STATUSES, 'all'] as const;
export type MerchantReturnBucket = (typeof MERCHANT_RETURN_BUCKETS)[number];

export interface MerchantReturnCounts {
  requested: number;
  approved: number;
  rejected: number;
  cancelled: number;
  all: number;
}

/**
 * One return, as the seller's queue draws it.
 *
 * The bare `order_returns` row carries an order id, a customer id and two
 * amounts — nothing a card can be built from. This is the same projection
 * `MerchantOrdersService` exists to provide for the order queue, for the same
 * reason: a seller deciding on a return is deciding about a sale, and a uuid is
 * not a sale.
 */
export interface MerchantReturnRow {
  id: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  /** The buyer's own words. Required at request time; never empty. */
  reason: string;
  /** Fixed at request time from the order total, so a decision is about a known amount. */
  refundPesewas: number;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  buyerName: string | null;
  buyerPhone: string | null;
  /** "Ankara Wrap Dress + 2 more", or null if the lines are gone. */
  itemSummary: string | null;
  /**
   * What approving costs the seller: the net they were credited on this sale.
   *
   * Derived here rather than in the client because it is `total − commission`
   * at the order's OWN `commission_bps`, and a client that recomputed it from
   * the merchant's current default rate would be wrong for every order placed
   * before the last rate change. This is the number the decision turns on and
   * the one the canvas never showed.
   */
  merchantLosesPesewas: number;
  /** Ejua's commission on the sale, reversed alongside the seller's net. */
  commissionReversedPesewas: number;
}

export interface MerchantReturnDetail extends MerchantReturnRow {
  /** Every line on the order, so the seller can see what is coming back. */
  items: { title: string; quantity: number; unitPricePesewas: number }[];
  orderTotalPesewas: number;
  orderStatus: string;
  orderPlacedAt: string | null;
}

interface ReturnJoinRow {
  r: typeof schema.order_returns.$inferSelect;
  order_number: string;
  order_total: number;
  order_status: string;
  order_placed_at: string | null;
  commission_bps: number;
  buyer_name: string | null;
  buyer_phone: string | null;
}

/**
 * The seller's view of what is being sent back.
 *
 * Reads only. Deciding a return is `ReturnsService.approve` / `.reject`, which
 * owns the ledger, the restock and the refund obligation in one transaction —
 * splitting the read projection out keeps that service about the write.
 *
 * Every query joins `orders` and filters on `orders.merchant_id`, so a return
 * against somebody else's sale answers 404 rather than 403, for the same reason
 * as everywhere else on the scoped surface.
 */
export class MerchantReturnsService {
  constructor(private readonly db: Database) {}

  async list(
    merchantId: string,
    opts: { bucket?: MerchantReturnBucket; limit?: number; offset?: number } = {},
  ): Promise<{ rows: MerchantReturnRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where =
      opts.bucket && opts.bucket !== 'all'
        ? and(eq(o.merchant_id, merchantId), eq(ret.status, opts.bucket))
        : eq(o.merchant_id, merchantId);

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .where(where);

    const rows = await this.db
      .select(this.projection())
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .leftJoin(cust, eq(cust.id, ret.customer_id))
      .where(where)
      // Waiting-on-you first regardless of age, then newest. A seller opening
      // this screen is opening it to decide something, and a queue that buried
      // one open request under thirty settled ones would be a queue they stop
      // opening.
      .orderBy(sql`(${ret.status} = 'requested') DESC`, desc(ret.requested_at))
      .limit(limit)
      .offset(offset);
    if (rows.length === 0) return { rows: [], total: count };

    const summaries = await this.itemSummaries(rows.map((r) => r.r.order_id));
    return {
      rows: rows.map((r) => this.toRow(r, summaries.get(r.r.order_id) ?? null)),
      total: count,
    };
  }

  /**
   * Counts for the filter chips.
   *
   * One grouped query rather than five, and computed over the whole set rather
   * than the page — deriving them from a page would under-report the moment a
   * seller has more returns than fit on one, and "0 waiting on you" is a worse
   * lie than no number at all.
   */
  async counts(merchantId: string): Promise<MerchantReturnCounts> {
    const rows = await this.db
      .select({ status: ret.status, count: sql<number>`count(*)::int` })
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .where(eq(o.merchant_id, merchantId))
      .groupBy(ret.status);

    const counts: MerchantReturnCounts = {
      requested: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      all: 0,
    };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as ReturnStatus] = row.count;
      counts.all += row.count;
    }
    return counts;
  }

  /**
   * One return in full.
   *
   * Queried directly by id rather than filtered out of a list page — the same
   * bug the plan detail had, where the 51st return could be listed and not
   * opened.
   */
  async detail(merchantId: string, returnId: string): Promise<MerchantReturnDetail> {
    const rows = await this.db
      .select(this.projection())
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .leftJoin(cust, eq(cust.id, ret.customer_id))
      .where(and(eq(ret.id, returnId), eq(o.merchant_id, merchantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ReturnNotFoundError(returnId);

    const items = await this.db
      .select()
      .from(oi)
      .where(eq(oi.order_id, row.r.order_id))
      // `id` as the tiebreak: every line of one order is inserted in the same
      // statement and shares `created_at` to the microsecond, so without it the
      // list reorders itself between refetches.
      .orderBy(asc(oi.created_at), asc(oi.id));

    const summary = summarise(items.map((i) => i.title));
    return {
      ...this.toRow(row, summary),
      items: items.map((i) => ({
        title: i.title,
        quantity: i.quantity,
        unitPricePesewas: i.unit_price_pesewas,
      })),
      orderTotalPesewas: row.order_total,
      orderStatus: row.order_status,
      orderPlacedAt: row.order_placed_at,
    };
  }

  private projection() {
    return {
      r: ret,
      order_number: o.order_number,
      order_total: o.total_pesewas,
      order_status: o.status,
      order_placed_at: o.placed_at,
      commission_bps: o.commission_bps,
      buyer_name: buyerName,
      buyer_phone: cust.phone,
    };
  }

  private toRow(row: ReturnJoinRow, itemSummary: string | null): MerchantReturnRow {
    // The same arithmetic `ReturnsService.approve` books, and deliberately the
    // same call: `Money.multiplyBps` is what writes the reversal, so a screen
    // that rounded differently would promise a seller a number the ledger then
    // contradicts by a pesewa.
    const commission = Money.fromPesewas(row.order_total)
      .multiplyBps(row.commission_bps)
      .toNumber();
    return {
      id: row.r.id,
      orderId: row.r.order_id,
      orderNumber: row.order_number,
      status: row.r.status as ReturnStatus,
      reason: row.r.reason,
      refundPesewas: row.r.refund_amount_pesewas,
      requestedAt: row.r.requested_at,
      decidedAt: row.r.decided_at,
      decisionNote: row.r.decision_note,
      buyerName: row.buyer_name,
      buyerPhone: row.buyer_phone,
      itemSummary,
      merchantLosesPesewas: row.order_total - commission,
      commissionReversedPesewas: commission,
    };
  }

  private async itemSummaries(orderIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ order_id: oi.order_id, title: oi.title })
      .from(oi)
      .where(inArray(oi.order_id, orderIds))
      .orderBy(asc(oi.created_at), asc(oi.id));
    const byOrder = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byOrder.get(row.order_id);
      if (bucket) bucket.push(row.title);
      else byOrder.set(row.order_id, [row.title]);
    }
    const out = new Map<string, string>();
    for (const [orderId, titles] of byOrder) {
      const summary = summarise(titles);
      if (summary) out.set(orderId, summary);
    }
    return out;
  }
}

/** `["Dress","Scarf","Bag"]` → `"Dress + 2 more"`. */
function summarise(titles: string[]): string | null {
  const first = titles[0];
  if (!first) return null;
  return titles.length === 1 ? first : `${first} + ${titles.length - 1} more`;
}
