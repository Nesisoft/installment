import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  RETURN_STATUSES,
  listReturnsSchema,
  type ListReturnsInput,
  type ReturnStatus,
} from './dto';

const ret = schema.order_returns;
const o = schema.orders;
const oi = schema.order_items;

/**
 * The buckets the buyer's own returns list is filtered by.
 *
 * The same four statuses the seller sees plus `all`, deliberately identical to
 * `MERCHANT_RETURN_BUCKETS` rather than a buyer-flavoured re-grouping: the two
 * screens are looking at the same rows from opposite sides, and a buyer whose
 * "Waiting" chip meant something different from the seller's "Requested" one
 * would be reading a different story about the same request.
 */
export const CUSTOMER_RETURN_BUCKETS = [...RETURN_STATUSES, 'all'] as const;
export type CustomerReturnBucket = (typeof CUSTOMER_RETURN_BUCKETS)[number];

export interface CustomerReturnCounts {
  requested: number;
  approved: number;
  rejected: number;
  cancelled: number;
  all: number;
}

/**
 * One return, as the buyer's list draws it.
 *
 * `listForCustomer` returns bare `order_returns` rows — an order id, a customer
 * id and two amounts. A buyer looking at their own list needs to recognise
 * which purchase each row is about, and a uuid is not a purchase. This is the
 * customer-side twin of `MerchantReturnRow`, built for the same reason and
 * carrying the same order number and item summary.
 *
 * What it deliberately does NOT carry is the seller's half: no buyer name or
 * phone (the buyer is the caller), and none of the commission arithmetic. What
 * approving costs the seller is the seller's business, and the buyer's refund
 * is the gross order total either way.
 */
export interface CustomerReturnRow {
  id: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  /** The buyer's own words, as they typed them. Required at request time. */
  reason: string;
  /** Fixed at request time from the order total, so it cannot move while the seller thinks. */
  refundPesewas: number;
  requestedAt: string;
  /**
   * When the seller answered. Null for `requested` AND for `cancelled` —
   * `order_returns_decided_together` requires it, because a withdrawal is the
   * request going away rather than the seller deciding. A screen that labels
   * its date by status has to fall back to `requestedAt` for both.
   */
  decidedAt: string | null;
  /** Why it was refused, in the seller's words. Only ever set on `rejected`. */
  decisionNote: string | null;
  /** "Ankara Wrap Dress + 1 more", or null if the lines are gone. */
  itemSummary: string | null;
  /**
   * Whether the buyer can still take this back.
   *
   * Derived here rather than in the client because it is the same rule
   * `ReturnsService.withdraw` enforces — only while nobody has decided — and a
   * screen that recomputed it would be the second copy of a rule that has one
   * enforcement point. It is a projection of `status`, not new state.
   */
  canWithdraw: boolean;
}

/**
 * The buyer's own view of what they asked to send back.
 *
 * A separate service from `ReturnsService` for the same reason
 * `MerchantReturnsService` is: that class owns the writes and the invariants,
 * and a read projection joined across three tables has nothing to do with them.
 * Writes stay where the locks are.
 */
export class CustomerReturnsService {
  constructor(private readonly db: Database) {}

  async list(customerId: string, rawInput: unknown = {}): Promise<CustomerReturnRow[]> {
    const input: ListReturnsInput = listReturnsSchema.parse(rawInput);

    const rows = await this.db
      .select({
        r: ret,
        order_number: o.order_number,
      })
      .from(ret)
      .innerJoin(o, eq(o.id, ret.order_id))
      .where(
        and(
          eq(ret.customer_id, customerId),
          ...(input.status ? [eq(ret.status, input.status)] : []),
        ),
      )
      .orderBy(desc(ret.requested_at))
      .limit(input.limit)
      .offset(input.offset);

    if (rows.length === 0) return [];

    // One extra query for the whole page rather than one per row. The seller's
    // queue does exactly this; a per-row lookup is the N+1 the projection
    // exists to avoid.
    const summaries = await this.itemSummaries(rows.map((row) => row.r.order_id));

    return rows.map((row) => ({
      id: row.r.id,
      orderId: row.r.order_id,
      orderNumber: row.order_number,
      status: row.r.status as ReturnStatus,
      reason: row.r.reason,
      refundPesewas: row.r.refund_amount_pesewas,
      requestedAt: row.r.requested_at,
      decidedAt: row.r.decided_at,
      decisionNote: row.r.decision_note,
      itemSummary: summaries.get(row.r.order_id) ?? null,
      canWithdraw: row.r.status === 'requested',
    }));
  }

  async counts(customerId: string): Promise<CustomerReturnCounts> {
    const rows = await this.db
      .select({ status: ret.status, count: sql<number>`count(*)::int` })
      .from(ret)
      .where(eq(ret.customer_id, customerId))
      .groupBy(ret.status);

    const counts: CustomerReturnCounts = {
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

  private async itemSummaries(orderIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ order_id: oi.order_id, title: oi.title })
      .from(oi)
      .where(inArray(oi.order_id, orderIds))
      // `order_items` has no position column — the ordering is by insertion
      // time with the id as a tiebreak, the same compromise the seller's
      // summary makes. Recorded in merchant-app.md as needing a `position`.
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
