import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PLAN_ACCRUAL_TX_PREFIX } from '@installment/core';
import type { Database } from '@installment/db';
import { ORDER_PAYMENT_TX_PREFIX } from '../orders/orders.service';

/**
 * The windows the merchant app offers. Anything else is refused rather than
 * silently clamped: a client asking for 45 days and being handed 30 days of
 * numbers would read them as 45 days of numbers.
 */
export const MERCHANT_STATS_WINDOWS = [7, 30, 90] as const;
export type MerchantStatsWindow = (typeof MERCHANT_STATS_WINDOWS)[number];

export const merchantStatsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine(
      (n): n is MerchantStatsWindow => (MERCHANT_STATS_WINDOWS as readonly number[]).includes(n),
      { message: `days must be one of ${MERCHANT_STATS_WINDOWS.join(', ')}` },
    )
    .default(30),
});
export type MerchantStatsQuery = z.infer<typeof merchantStatsQuerySchema>;

/** One day of trading. Every day in the window is present, zeroes included. */
export interface MerchantStatsDay {
  /** `YYYY-MM-DD`, UTC — which for Ghana (UTC+0, no DST) is the local day. */
  date: string;
  orders: number;
  grossSoldPesewas: number;
}

/** One side of the payment-type split. */
export interface MerchantStatsByPaymentType {
  orders: number;
  grossSoldPesewas: number;
  /** `grossSoldPesewas / orders` for this side alone. 0 with no orders. */
  averageBasketPesewas: number;
  /**
   * Share of the period's orders, to one decimal place. `null` when the period
   * sold nothing: a share of no orders is not 0%, it is undefined, and a client
   * rendering "0% paid in instalments" for a shop that sold nothing has said
   * something false.
   */
  shareOfOrdersPct: number | null;
}

/**
 * How the period's sales split between paying outright and paying over time.
 *
 * Derived from `orders.payment_type`, which checkout writes as exactly `full`
 * or `installment` and the column's CHECK permits nothing else — so unlike the
 * traffic-sources card below, this is a real division of real rows. It comes
 * out of the same query as the headline figures, which means the two sides
 * always add up to `orders` and `grossSoldPesewas`; a mix that did not
 * reconcile with the number above it would be worse than no mix at all.
 */
export interface MerchantStatsPaymentMix {
  /** Orders with a credit plan behind them — "Pay in 4" and its siblings. */
  installment: MerchantStatsByPaymentType;
  /** Orders paid in one go, on MoMo or a card. */
  full: MerchantStatsByPaymentType;
}

export interface MerchantStatsPeriod {
  from: string;
  to: string;
  /**
   * Order value placed in the period, excluding orders since cancelled or
   * returned — so a sale that falls through stops counting as one. `defaulted`
   * still counts: the merchant was paid at approval and it is the reserve, not
   * the merchant, that carries that loss.
   */
  grossSoldPesewas: number;
  orders: number;
  /** `grossSoldPesewas / orders`, floored to the pesewa. 0 with no orders. */
  averageBasketPesewas: number;
  /**
   * Of what was sold in this period, what the books say is the merchant's after
   * MDR (or marketplace commission on an outright sale) and reserve. Read from
   * `ledger_entries` rather than recomputed from rates: the ledger is what the
   * payout run actually pays against.
   */
  netEarnedPesewas: number;
  /**
   * Everything credited to `merchant_payable` during the period, whatever it
   * was for. Differs from `netEarnedPesewas` because reserve released this week
   * belongs to a sale from months ago — this is the figure that reconciles
   * against the statement; the other is the one that pairs with `grossSold`.
   */
  creditedPesewas: number;
  /**
   * Orders cancelled during the period, whenever they were raised.
   *
   * Every one of these is a checkout that fell over before money moved:
   * `OrdersService.cancel` accepts only `pending_payment`, `pending_approval`
   * and `payment_failed`, and nothing else in the system writes
   * `orders.status = 'cancelled'`. A paid order that goes wrong is a refund,
   * which does not touch the order's status at all.
   *
   * So this is a funnel number, not a fulfilment one, and the API says so
   * rather than shipping a second "cancelled after payment" figure that could
   * only ever read zero.
   */
  cancelledOrders: number;
  /** What those abandoned orders would have been worth. */
  cancelledValuePesewas: number;
  /** Instalments versus paid outright, over the same orders as above. */
  paymentMix: MerchantStatsPaymentMix;
}

/**
 * Period-over-period movement, as a percentage. `null` where the previous
 * period was zero — there is no percentage change from nothing, and a client
 * that renders `null` as "no prior data" is right where one rendering
 * `Infinity` as `+∞%` is not.
 */
export interface MerchantStatsChange {
  grossSoldPct: number | null;
  ordersPct: number | null;
  averageBasketPct: number | null;
  netEarnedPct: number | null;
}

/**
 * One product's contribution to the window, for the "Best sellers" list.
 *
 * `unitsSold` counts `order_items.quantity` rather than orders, because a
 * merchant restocking reads units; `stockAvailable` sums `quantity_available`
 * across the product's live variants, which is what "33 left" means on the
 * shelf. A product deleted since the sale keeps its sale — `order_items.title`
 * is denormalised at checkout precisely so history does not change when a
 * catalogue row does — and then has no stock to report, so `stockAvailable`
 * is `null` rather than 0: "we do not know" and "none left" are different
 * things to a seller deciding what to reorder.
 */
export interface MerchantStatsTopProduct {
  /** `null` once the catalogue row is gone; the sale still counts. */
  productId: string | null;
  title: string;
  unitsSold: number;
  grossSoldPesewas: number;
  stockAvailable: number | null;
}

export interface MerchantStats {
  merchantId: string;
  windowDays: MerchantStatsWindow;
  generatedAt: string;
  current: MerchantStatsPeriod;
  /** The window of equal length immediately before `current`. */
  previous: MerchantStatsPeriod;
  change: MerchantStatsChange;
  /** `current`, day by day, oldest first. */
  daily: MerchantStatsDay[];
  /** `current`'s best sellers by units, most sold first. At most 5. */
  topProducts: MerchantStatsTopProduct[];
}

/**
 * Orders that reached these states did not end up being sales.
 *
 * Both have writers now: `OrdersService.cancel` for the first and
 * `ReturnsService.approve` for the second, which was listed here before it
 * could happen so that revenue would not silently keep counting a returned
 * order the day returns shipped.
 */
const NOT_A_SALE = ['cancelled', 'returned'];

/**
 * `o.status NOT IN ('cancelled', 'returned')`, bound rather than interpolated.
 * Built once from {@link NOT_A_SALE} so the list has a single definition.
 */
const IS_A_SALE = sql`o.status NOT IN (${sql.join(
  NOT_A_SALE.map((status) => sql`${status}`),
  sql`, `,
)})`;

interface SoldRow {
  day: string;
  payment_type: PaymentType;
  orders: number;
  gross: string;
}

/** The whole vocabulary of `orders.payment_type`, per its CHECK constraint. */
type PaymentType = 'installment' | 'full';
interface NetRow {
  day: string;
  net: string;
}
interface CancelRow {
  cancelled: number;
  value: string;
}
interface CreditedRow {
  credited: string;
}
interface TopProductRow {
  product_id: string | null;
  title: string;
  units: number;
  gross: string;
  stock: number | null;
}

/**
 * A merchant's own trading figures over a rolling window, and the window before
 * it.
 *
 * Every number here is derived from rows the rest of the system already writes:
 * `orders.placed_at` (stamped in the same transaction that makes an order the
 * seller's — on payment, or on financing going live), the `order.cancelled`
 * timeline event, and `merchant_payable` in the ledger. Nothing is estimated
 * and nothing is modelled.
 *
 * The payment-type split is the one breakdown here, and it is one the rows can
 * answer: `orders.payment_type` is written by checkout and constrained to
 * exactly two values.
 *
 * Deliberately absent: where the order came from. The design has a
 * traffic-sources card — marketplace search / flyer links / category browse /
 * shop followers, with percentages — and there is no attribution model anywhere
 * in this system that could fill it. `orders.source` distinguishes `internal`
 * from `partner` and nothing else; no referrer, campaign, or session is
 * recorded at any point in checkout. Four plausible percentages would be a
 * fabrication a merchant might act on, so that card has no endpoint behind it
 * and should come off the screen.
 */
export class MerchantStatsService {
  constructor(private readonly db: Database) {}

  async forMerchant(merchantId: string, rawQuery: unknown = {}): Promise<MerchantStats> {
    const { days } = merchantStatsQuerySchema.parse(rawQuery);

    // `to` is the start of tomorrow, so today counts in full and the window is
    // exactly `days` whole day-buckets ending with today.
    const now = new Date();
    const to = startOfNextUtcDay(now);
    const currentFrom = addDays(to, -days);
    const previousFrom = addDays(to, -days * 2);

    const [
      sold,
      net,
      currentCancels,
      previousCancels,
      currentCredited,
      previousCredited,
      topProducts,
    ] = await Promise.all([
      this.soldByDay(merchantId, previousFrom, to),
      this.netByDay(merchantId, previousFrom, to),
      this.cancellations(merchantId, currentFrom, to),
      this.cancellations(merchantId, previousFrom, currentFrom),
      this.credited(merchantId, currentFrom, to),
      this.credited(merchantId, previousFrom, currentFrom),
      this.topProducts(merchantId, currentFrom, to),
    ]);

    const currentDays = fillDays(sold, net, currentFrom, to);
    const previousDays = fillDays(sold, net, previousFrom, currentFrom);

    const current = period(
      currentFrom,
      to,
      currentDays,
      currentCancels,
      currentCredited,
      paymentMix(sold, currentFrom, to),
    );
    const previous = period(
      previousFrom,
      currentFrom,
      previousDays,
      previousCancels,
      previousCredited,
      paymentMix(sold, previousFrom, currentFrom),
    );

    return {
      merchantId,
      windowDays: days,
      generatedAt: now.toISOString(),
      current,
      previous,
      change: {
        grossSoldPct: pctChange(previous.grossSoldPesewas, current.grossSoldPesewas),
        ordersPct: pctChange(previous.orders, current.orders),
        averageBasketPct: pctChange(previous.averageBasketPesewas, current.averageBasketPesewas),
        netEarnedPct: pctChange(previous.netEarnedPesewas, current.netEarnedPesewas),
      },
      daily: currentDays.map(({ date, orders, grossSoldPesewas }) => ({
        date,
        orders,
        grossSoldPesewas,
      })),
      topProducts,
    };
  }

  /**
   * What sold most in the window, by units.
   *
   * Grouped on `order_items.product_id` so two sizes of the same dress are one
   * row, and left-joined to inventory so the seller sees what is left without a
   * second call per product. The join is to `product_variants` rather than to
   * the item's own `variant_id`: stock is a property of the product's whole
   * range today, not of the variants that happened to sell, and a merchant
   * reading "6 left" wants the shelf, not the one size in this order.
   *
   * Falls back to grouping by title where the catalogue row has been deleted —
   * `order_items.product_id` is `ON DELETE SET NULL`, and dropping those rows
   * would make the list disagree with the headline total above it.
   */
  private async topProducts(
    merchantId: string,
    from: Date,
    to: Date,
  ): Promise<MerchantStatsTopProduct[]> {
    const result = await this.db.execute(sql`
      WITH sold AS (
        SELECT oi.product_id                                AS product_id,
               min(oi.title)                                AS title,
               sum(oi.quantity)::int                        AS units,
               coalesce(sum(oi.line_total_pesewas), 0)::text AS gross
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.merchant_id = ${merchantId}
          AND o.placed_at  >= ${from.toISOString()}
          AND o.placed_at  <  ${to.toISOString()}
          AND ${IS_A_SALE}
        GROUP BY coalesce(oi.product_id::text, oi.title), oi.product_id
      )
      SELECT s.product_id,
             s.title,
             s.units,
             s.gross,
             stock.available AS stock
      FROM sold s
      LEFT JOIN LATERAL (
        SELECT sum(i.quantity_available)::int AS available
        FROM product_variants pv
        JOIN inventory i ON i.variant_id = pv.id
        WHERE pv.product_id = s.product_id
      ) stock ON TRUE
      ORDER BY s.units DESC, s.title ASC
      LIMIT 5
    `);
    return (result.rows as unknown as TopProductRow[]).map((r) => ({
      productId: r.product_id,
      title: r.title,
      unitsSold: Number(r.units),
      grossSoldPesewas: toPesewas(r.gross),
      // `null` both when the product is gone and when it has no inventory rows
      // at all — in either case the app has nothing true to say about stock.
      stockAvailable: r.stock === null || r.stock === undefined ? null : Number(r.stock),
    }));
  }

  /**
   * Orders and their value, bucketed by the UTC day they were placed.
   *
   * `placed_at` and not `created_at`: a cart the customer walked away from was
   * never a sale, and counting it would tell a merchant they sold something
   * they did not.
   */
  private async soldByDay(merchantId: string, from: Date, to: Date): Promise<SoldRow[]> {
    const result = await this.db.execute(sql`
      SELECT to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             o.payment_type                                        AS payment_type,
             count(*)::int                                         AS orders,
             coalesce(sum(o.total_pesewas), 0)::text               AS gross
      FROM orders o
      WHERE o.merchant_id = ${merchantId}
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <  ${to.toISOString()}
        AND ${IS_A_SALE}
      GROUP BY 1, 2
      ORDER BY 1
    `);
    return result.rows as unknown as SoldRow[];
  }

  /**
   * What those same orders put in the merchant's account, by the day of the
   * sale rather than the day of the booking.
   *
   * The join reaches the two shapes of accrual this system books: one
   * transaction per outright payment, and one per payout trigger on a plan. A
   * plan can fire several (BNPL fires once at approval today, but the model
   * table permits per-instalment triggers), so this sums rather than picking
   * one — and it is why the order count comes from a separate query, where a
   * plan with two accruals cannot count as two orders.
   */
  private async netByDay(merchantId: string, from: Date, to: Date): Promise<NetRow[]> {
    const result = await this.db.execute(sql`
      SELECT to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             coalesce(sum(le.amount_pesewas), 0)::text             AS net
      FROM orders o
      JOIN ledger_entries le
        ON le.account_type = 'merchant_payable'
       AND le.account_ref  = ${merchantId}
       AND le.direction    = 'credit'
       AND (
             le.transaction_id = ${ORDER_PAYMENT_TX_PREFIX} || o.id::text
             OR (o.customer_plan_id IS NOT NULL
                 AND le.transaction_id LIKE ${PLAN_ACCRUAL_TX_PREFIX} || o.customer_plan_id::text || ':%')
           )
      WHERE o.merchant_id = ${merchantId}
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <  ${to.toISOString()}
        AND ${IS_A_SALE}
      GROUP BY 1
    `);
    return result.rows as unknown as NetRow[];
  }

  /**
   * Cancellations by when they were cancelled, not when the order was raised.
   *
   * The timestamp comes from the `order.cancelled` timeline event because
   * `orders` has no cancellation column — only `updated_at`, which any later
   * write moves. `OrdersService.cancel` is the single writer of both, and its
   * transition guard means one event per order.
   */
  private async cancellations(merchantId: string, from: Date, to: Date): Promise<CancelRow> {
    const result = await this.db.execute(sql`
      SELECT count(*)::int                              AS cancelled,
             coalesce(sum(o.total_pesewas), 0)::text    AS value
      FROM orders o
      JOIN order_events e
        ON e.order_id = o.id
       AND e.event_type = 'order.cancelled'
      WHERE o.merchant_id = ${merchantId}
        AND e.occurred_at >= ${from.toISOString()}
        AND e.occurred_at <  ${to.toISOString()}
    `);
    const row = (result.rows as unknown as CancelRow[])[0];
    return row ?? { cancelled: 0, value: '0' };
  }

  /** Everything credited to the merchant's account in the period. */
  private async credited(merchantId: string, from: Date, to: Date): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT coalesce(sum(amount_pesewas), 0)::text AS credited
      FROM ledger_entries
      WHERE account_type = 'merchant_payable'
        AND account_ref  = ${merchantId}
        AND direction    = 'credit'
        AND occurred_at >= ${from.toISOString()}
        AND occurred_at <  ${to.toISOString()}
    `);
    return toPesewas((result.rows as unknown as CreditedRow[])[0]?.credited);
  }
}

// --------------------------------------------------------------- pure helpers

interface DayTotals extends MerchantStatsDay {
  netEarnedPesewas: number;
}

/** Midnight UTC on the day after `d`. */
export function startOfNextUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every day in `[from, to)`, whether or not anything was sold on it.
 *
 * A sparse series is what makes a bar chart lie: seven bars for a week with
 * three trading days reads as seven trading days, and the gaps are exactly the
 * information a merchant is looking at the chart for.
 */
export function fillDays(sold: SoldRow[], net: NetRow[], from: Date, to: Date): DayTotals[] {
  // One row per (day, payment_type) now, so a day with both kinds of sale has
  // two — summed back together here, because the chart is one bar per day.
  const soldBy = new Map<string, { orders: number; gross: number }>();
  for (const r of sold) {
    const acc = soldBy.get(r.day) ?? { orders: 0, gross: 0 };
    soldBy.set(r.day, {
      orders: acc.orders + Number(r.orders),
      gross: acc.gross + toPesewas(r.gross),
    });
  }
  const netBy = new Map(net.map((r) => [r.day, r]));
  const out: DayTotals[] = [];
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const key = utcDateKey(d);
    out.push({
      date: key,
      orders: soldBy.get(key)?.orders ?? 0,
      grossSoldPesewas: soldBy.get(key)?.gross ?? 0,
      netEarnedPesewas: toPesewas(netBy.get(key)?.net),
    });
  }
  return out;
}

/**
 * The payment-type split for one period, from the same rows as everything else.
 *
 * Sliced on the date key rather than re-queried: `YYYY-MM-DD` sorts
 * lexicographically, so the half-open `[from, to)` the rest of this file works
 * in is a plain string comparison, and the mix is guaranteed to reconcile with
 * the totals because it is the same numbers added up a different way.
 */
export function paymentMix(sold: SoldRow[], from: Date, to: Date): MerchantStatsPaymentMix {
  const fromKey = utcDateKey(from);
  const toKey = utcDateKey(to);
  const inPeriod = sold.filter((r) => r.day >= fromKey && r.day < toKey);
  const totalOrders = inPeriod.reduce((n, r) => n + Number(r.orders), 0);

  const side = (type: PaymentType): MerchantStatsByPaymentType => {
    const rows = inPeriod.filter((r) => r.payment_type === type);
    const orders = rows.reduce((n, r) => n + Number(r.orders), 0);
    const grossSoldPesewas = rows.reduce((n, r) => n + toPesewas(r.gross), 0);
    return {
      orders,
      grossSoldPesewas,
      averageBasketPesewas: orders === 0 ? 0 : Math.floor(grossSoldPesewas / orders),
      shareOfOrdersPct: totalOrders === 0 ? null : Math.round((orders / totalOrders) * 1000) / 10,
    };
  };

  return { installment: side('installment'), full: side('full') };
}

function period(
  from: Date,
  to: Date,
  days: DayTotals[],
  cancels: CancelRow,
  creditedPesewas: number,
  mix: MerchantStatsPaymentMix,
): MerchantStatsPeriod {
  const grossSoldPesewas = days.reduce((n, d) => n + d.grossSoldPesewas, 0);
  const orders = days.reduce((n, d) => n + d.orders, 0);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    grossSoldPesewas,
    orders,
    // Integer pesewas all the way down — an average basket is money, and money
    // here is never a float.
    averageBasketPesewas: orders === 0 ? 0 : Math.floor(grossSoldPesewas / orders),
    netEarnedPesewas: days.reduce((n, d) => n + d.netEarnedPesewas, 0),
    creditedPesewas,
    cancelledOrders: Number(cancels.cancelled ?? 0),
    cancelledValuePesewas: toPesewas(cancels.value),
    paymentMix: mix,
  };
}

/** Percentage change, to one decimal place. `null` when there is no baseline. */
export function pctChange(previous: number, current: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * Postgres returns `sum()` over a bigint column as numeric, which the driver
 * hands back as a string so nothing is lost on the way. Everything in this file
 * is integer pesewas, so parse rather than letting a string reach arithmetic.
 */
function toPesewas(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}
