import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { OrderNotFoundError } from './errors';
import { ORDER_STATUSES, type OrderStatus } from './order-state';
import type { Order } from './orders.service';
import type { MerchantOrderDetail, MerchantOrdersService } from './merchant-orders.service';
import type { OrderReturn } from '../returns/returns.service';

const o = schema.orders;
const oi = schema.order_items;
const cust = schema.customers;
const merch = schema.merchants;
const st = schema.stores;
const ret = schema.order_returns;
const rf = schema.refunds;

const customerName = sql<
  string | null
>`nullif(trim(concat_ws(' ', ${cust.first_name}, ${cust.last_name})), '')`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One order in the console's list: the order, and who it is between. */
export interface AdminOrderRow extends Order {
  item_count: number;
  customer_name: string | null;
  merchant_name: string | null;
  store_name: string | null;
}

/** A return on the order, with the refund it raised, if any. */
export interface AdminOrderReturn extends OrderReturn {
  refund: {
    reference: string;
    status: string;
    method: string;
    amount_pesewas: number;
  } | null;
}

/**
 * One order as staff see it.
 *
 * The seller's order sheet already resolves the delivery, the history, what
 * the ledger booked and the plan behind it; this is that, plus the two things
 * the seller's view deliberately leaves out — the buyer's full contact, and
 * which seller it is — and the returns, which the seller sees on another
 * screen.
 */
export interface AdminOrderDetail extends MerchantOrderDetail {
  customer: { id: string; name: string | null; phone: string; email: string } | null;
  merchant: { id: string; business_name: string } | null;
  store: { id: string; display_name: string; slug: string } | null;
  returns: AdminOrderReturn[];
}

export interface ListAdminOrdersInput {
  status?: OrderStatus;
  payment_type?: 'full' | 'installment';
  /** An order number, or part of one, or an order id. */
  q?: string;
  limit?: number;
  offset?: number;
}

export type AdminOrderCounts = Record<OrderStatus | 'all', number>;

/**
 * Orders across every seller, for the operations console.
 *
 * The admin order routes could confirm a payment and cancel an order, but
 * nothing could find one: there was no list and no detail, so an operator
 * reconciling a bank transfer needed the order's uuid from somewhere else
 * before the button that books it was any use.
 */
export class AdminOrdersService {
  constructor(
    private readonly db: Database,
    private readonly merchantOrders: Pick<MerchantOrdersService, 'detail'>,
  ) {}

  async list(input: ListAdminOrdersInput = {}): Promise<{ rows: AdminOrderRow[]; total: number }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);

    const conditions: SQL[] = [];
    if (input.status) conditions.push(eq(o.status, input.status));
    if (input.payment_type) conditions.push(eq(o.payment_type, input.payment_type));
    const q = input.q?.trim();
    if (q) {
      const byNumber = ilike(o.order_number, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      conditions.push(UUID.test(q) ? or(eq(o.id, q), byNumber)! : byNumber);
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(o)
      .where(where);

    const rows = await this.db
      .select({
        order: o,
        item_count: sql<number>`(SELECT coalesce(sum(${oi.quantity}), 0)::int FROM ${oi} WHERE ${oi.order_id} = ${o.id})`,
        customer_name: customerName,
        merchant_name: merch.business_name,
        store_name: st.display_name,
      })
      .from(o)
      .leftJoin(cust, eq(cust.id, o.customer_id))
      .leftJoin(merch, eq(merch.id, o.merchant_id))
      .leftJoin(st, eq(st.id, o.store_id))
      .where(where)
      .orderBy(desc(o.created_at), desc(o.id))
      .limit(limit)
      .offset(offset);

    return {
      rows: rows.map((r) => ({
        ...r.order,
        item_count: r.item_count,
        customer_name: r.customer_name,
        merchant_name: r.merchant_name,
        store_name: r.store_name,
      })),
      total,
    };
  }

  /** How many orders are in each status — the list's filter, and the dashboard. */
  async counts(): Promise<AdminOrderCounts> {
    const rows = await this.db
      .select({ status: o.status, count: sql<number>`count(*)::int` })
      .from(o)
      .groupBy(o.status);
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as AdminOrderCounts;
    counts.all = 0;
    for (const r of rows) {
      if ((ORDER_STATUSES as readonly string[]).includes(r.status)) {
        counts[r.status as OrderStatus] = r.count;
      }
      counts.all += r.count;
    }
    return counts;
  }

  async detail(orderId: string): Promise<AdminOrderDetail> {
    if (!UUID.test(orderId)) throw new OrderNotFoundError(orderId);
    const [row] = await this.db
      .select({
        merchant_id: o.merchant_id,
        customer: {
          id: cust.id,
          name: customerName,
          phone: cust.phone,
          email: cust.email,
        },
        merchant: { id: merch.id, business_name: merch.business_name },
        store: { id: st.id, display_name: st.display_name, slug: st.slug },
      })
      .from(o)
      .leftJoin(cust, eq(cust.id, o.customer_id))
      .leftJoin(merch, eq(merch.id, o.merchant_id))
      .leftJoin(st, eq(st.id, o.store_id))
      .where(eq(o.id, orderId))
      .limit(1);
    if (!row) throw new OrderNotFoundError(orderId);

    const [sheet, returns] = await Promise.all([
      this.merchantOrders.detail(row.merchant_id, orderId),
      this.db
        .select({
          ret,
          refund: {
            reference: rf.reference,
            status: rf.status,
            method: rf.method,
            amount_pesewas: rf.amount_pesewas,
          },
        })
        .from(ret)
        .leftJoin(rf, eq(rf.order_return_id, ret.id))
        .where(eq(ret.order_id, orderId))
        .orderBy(desc(ret.requested_at)),
    ]);

    return {
      ...sheet,
      customer: row.customer?.id ? row.customer : null,
      merchant: row.merchant?.id ? row.merchant : null,
      store: row.store?.id ? row.store : null,
      returns: returns.map((r) => ({
        ...r.ret,
        refund: r.refund?.reference ? r.refund : null,
      })),
    };
  }
}
