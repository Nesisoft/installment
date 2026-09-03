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
}

/**
 * Orders that reached these states did not end up being sales.
 *
 * Only `cancelled` has a writer today; `returned` is in the orders CHECK and in
 * the transition table with nothing that reaches it yet. It is listed anyway so
 * that whoever wires returns up does not have to remember that revenue silently
 * counts them.
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
  orders: number;
  gross: string;
}
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

    const [sold, net, currentCancels, previousCancels, currentCredited, previousCredited] =
      await Promise.all([
        this.soldByDay(merchantId, previousFrom, to),
        this.netByDay(merchantId, previousFrom, to),
        this.cancellations(merchantId, currentFrom, to),
        this.cancellations(merchantId, previousFrom, currentFrom),
        this.credited(merchantId, currentFrom, to),
        this.credited(merchantId, previousFrom, currentFrom),
      ]);

    const currentDays = fillDays(sold, net, currentFrom, to);
    const previousDays = fillDays(sold, net, previousFrom, currentFrom);

    const current = period(currentFrom, to, currentDays, currentCancels, currentCredited);
    const previous = period(
      previousFrom,
      currentFrom,
      previousDays,
      previousCancels,
      previousCredited,
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
    };
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
             count(*)::int                                         AS orders,
             coalesce(sum(o.total_pesewas), 0)::text               AS gross
      FROM orders o
      WHERE o.merchant_id = ${merchantId}
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <  ${to.toISOString()}
        AND ${IS_A_SALE}
      GROUP BY 1
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
  const soldBy = new Map(sold.map((r) => [r.day, r]));
  const netBy = new Map(net.map((r) => [r.day, r]));
  const out: DayTotals[] = [];
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const key = utcDateKey(d);
    out.push({
      date: key,
      orders: Number(soldBy.get(key)?.orders ?? 0),
      grossSoldPesewas: toPesewas(soldBy.get(key)?.gross),
      netEarnedPesewas: toPesewas(netBy.get(key)?.net),
    });
  }
  return out;
}

function period(
  from: Date,
  to: Date,
  days: DayTotals[],
  cancels: CancelRow,
  creditedPesewas: number,
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
