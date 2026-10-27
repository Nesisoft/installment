import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { PLAN_ACCRUAL_TX_PREFIX, reserveReleaseDate } from '@installment/core';
import { schema, type Database } from '@installment/db';
import { PlanNotFoundError } from './errors';
import type { MerchantOrdersService } from './merchant-orders.service';

const cp = schema.customer_plans;
const isch = schema.installment_schedule;
const hr = schema.held_reserves;
const cust = schema.customers;

/**
 * The buckets the seller's plan list is filtered by.
 *
 * `late` is the interesting one: there is NO late plan status.
 * `customer_plans.status` is constrained to active | completed | defaulted |
 * cancelled | restructured, and a plan whose customer has missed a payment
 * stays `active` — the arrears live one level down, on `installment_schedule`.
 * So "late" is a fact about the schedule and has to be derived, which is why
 * this is a bucket table and not a status filter.
 */
export const LATE_INSTALLMENT_STATUSES = ['overdue', 'in_collections', 'defaulted'] as const;

export const MERCHANT_PLAN_BUCKETS = ['active', 'late', 'completed', 'all'] as const;
export type MerchantPlanBucket = (typeof MERCHANT_PLAN_BUCKETS)[number];

export function isMerchantPlanBucket(value: string): value is MerchantPlanBucket {
  return (MERCHANT_PLAN_BUCKETS as readonly string[]).includes(value);
}

export type MerchantPlanCounts = Record<MerchantPlanBucket, number>;

export interface MerchantPlanInstallment {
  sequence_number: number;
  due_date: string;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  late_fee_pesewas: number;
  status: string;
  paid_at: string | null;
}

export interface MerchantPlanRow {
  id: string;
  status: string;
  business_model: string;
  /**
   * The sale, resolved through `orders.customer_plan_id`. Null once the order
   * is gone — the plan outlives it, and the canvas's `PL-…` reference does not
   * exist anywhere in this schema.
   */
  orderId: string | null;
  orderNumber: string | null;
  itemSummary: string | null;
  /** Name and nothing else: the seller is owed a name, not a customer record. */
  customerName: string | null;
  orderAmountPesewas: number;
  totalPayablePesewas: number;
  /** Summed off the schedule, so it reconciles with the rows on the detail. */
  collectedPesewas: number;
  paidCount: number;
  /** Payments the customer makes, deposit INCLUDED. */
  installmentCount: number;
  nextDueDate: string | null;
  /** Derived from the schedule; see {@link MERCHANT_PLAN_BUCKETS}. */
  late: boolean;
  /** Reserve still held against this plan, net of releases and defaults. */
  reserveOutstandingPesewas: number;
  createdAt: string;
}

export interface MerchantPlanDetail extends MerchantPlanRow {
  installments: MerchantPlanInstallment[];
  /**
   * What the ledger credited the merchant for this plan — the accrual, not a
   * recomputation from `mdr_bps`. The rate is what SHOULD have been charged;
   * this is what was.
   */
  settledPesewas: number;
  mdrPesewas: number;
  reserveWithheldPesewas: number;
  /**
   * The earliest date the model's policy allows the reserve out, or null while
   * the plan is still running. The clock starts at completion or default.
   */
  reserveReleasesAt: string | null;
  mdrBps: number;
  reserveBps: number;
}

interface PlanAggregateRow {
  plan_id: string;
  collected: string;
  paid_count: number;
  installments: number;
  next_due: string | null;
  late: boolean;
}

interface AccrualRow {
  net: string;
  mdr: string;
  reserve: string;
}

/**
 * A seller's view of the credit plans running against their sales.
 *
 * Ejua lends to the customer and collects; the seller was credited per their
 * plan type. What they need from this screen is therefore not "how much do I
 * chase" — nothing — but "what is Ejua collecting on my behalf, and what of my
 * money is still tied up in reserve".
 *
 * In commerce rather than core, even though `customer_plans` is an engine
 * table, because every useful row here needs the ORDER: what was sold, to whom,
 * under what reference. The dependency runs commerce → core, so this side can
 * read the engine's tables while the engine cannot read commerce's.
 */
export class MerchantPlansService {
  constructor(
    private readonly db: Database,
    /** Resolves plan → order; the schema only links the other way. */
    private readonly orders: Pick<MerchantOrdersService, 'ordersForPlans'>,
  ) {}

  async list(
    merchantId: string,
    opts: { bucket?: MerchantPlanBucket; limit?: number; offset?: number } = {},
  ): Promise<{ rows: MerchantPlanRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const bucket = opts.bucket ?? 'all';
    const where = and(eq(cp.merchant_id, merchantId), bucketFilter(bucket));

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(cp)
      .where(where);

    const plans = await this.db
      .select({ plan: cp, customerName: customerName })
      .from(cp)
      .leftJoin(cust, eq(cust.id, cp.customer_id))
      .where(where)
      // Total order, or paging repeats and skips rows. See
      // merchant-paging.integration.spec.ts.
      .orderBy(desc(cp.created_at), desc(cp.id))
      .limit(limit)
      .offset(offset);
    if (plans.length === 0) return { rows: [], total: count };

    const planIds = plans.map((p) => p.plan.id);
    const [schedules, orders, reserves] = await Promise.all([
      this.scheduleSummary(planIds),
      this.orders.ordersForPlans(merchantId, planIds),
      this.reservesFor(planIds),
    ]);

    return {
      rows: plans.map(({ plan, customerName: name }) => {
        const summary = schedules.get(plan.id);
        const order = orders.get(plan.id);
        return {
          id: plan.id,
          status: plan.status,
          business_model: plan.business_model,
          orderId: order?.orderId ?? null,
          orderNumber: order?.orderNumber ?? null,
          itemSummary: order?.itemSummary ?? null,
          customerName: name,
          orderAmountPesewas: plan.order_amount_pesewas,
          totalPayablePesewas: plan.total_payable_pesewas,
          collectedPesewas: summary?.collectedPesewas ?? 0,
          paidCount: summary?.paidCount ?? 0,
          installmentCount: summary?.installmentCount ?? 0,
          nextDueDate: summary?.nextDueDate ?? null,
          late: summary?.late ?? false,
          reserveOutstandingPesewas: reserves.get(plan.id)?.outstanding ?? 0,
          createdAt: plan.created_at,
        };
      }),
      total: count,
    };
  }

  /**
   * How many plans sit in each bucket.
   *
   * `late` cannot come from a GROUP BY on status the way the order buckets can,
   * because it is not a status — so it is counted separately, over the same
   * EXISTS the filter uses. Two queries, not four.
   */
  async counts(merchantId: string): Promise<MerchantPlanCounts> {
    const [byStatus, [lateRow]] = await Promise.all([
      this.db
        .select({ status: cp.status, count: sql<number>`count(*)::int` })
        .from(cp)
        .where(eq(cp.merchant_id, merchantId))
        .groupBy(cp.status),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(cp)
        .where(and(eq(cp.merchant_id, merchantId), bucketFilter('late'))),
    ]);

    const total = byStatus.reduce((n, r) => n + Number(r.count), 0);
    const active = byStatus.find((r) => r.status === 'active');
    const completed = byStatus.find((r) => r.status === 'completed');
    return {
      active: Number(active?.count ?? 0),
      late: Number(lateRow?.count ?? 0),
      completed: Number(completed?.count ?? 0),
      // Every plan on the seller's sales, including defaulted, cancelled and
      // restructured ones that no other chip shows — "All" that quietly
      // excluded them would not reconcile with the list it filters.
      all: total,
    };
  }

  async detail(merchantId: string, planId: string): Promise<MerchantPlanDetail> {
    // Queried directly, NOT found inside a page of `list`. A page is capped,
    // so filtering one would make the plans past the cap unopenable — the same
    // shape of bug that made the 26th order in a bucket unreachable.
    // `merchant_id` is in the WHERE clause, so another seller's plan answers
    // "not found" rather than "forbidden".
    const [found] = await this.db
      .select({ plan: cp, customerName: customerName })
      .from(cp)
      .leftJoin(cust, eq(cust.id, cp.customer_id))
      .where(and(eq(cp.id, planId), eq(cp.merchant_id, merchantId)))
      .limit(1);
    if (!found) throw new PlanNotFoundError(planId);
    const plan = found.plan;

    const [summary, orders, reserve, schedule, accrual] = await Promise.all([
      this.scheduleSummary([planId]).then((m) => m.get(planId) ?? null),
      this.orders.ordersForPlans(merchantId, [planId]),
      this.reservesFor([planId]).then((m) => m.get(planId) ?? null),
      this.db
        .select()
        .from(isch)
        .where(eq(isch.customer_plan_id, planId))
        .orderBy(asc(isch.sequence_number)),
      this.accrualFor(merchantId, planId),
    ]);
    const order = orders.get(planId);

    return {
      id: plan.id,
      status: plan.status,
      business_model: plan.business_model,
      orderId: order?.orderId ?? null,
      orderNumber: order?.orderNumber ?? null,
      itemSummary: order?.itemSummary ?? null,
      customerName: found.customerName,
      orderAmountPesewas: plan.order_amount_pesewas,
      totalPayablePesewas: plan.total_payable_pesewas,
      collectedPesewas: summary?.collectedPesewas ?? 0,
      paidCount: summary?.paidCount ?? 0,
      installmentCount: summary?.installmentCount ?? 0,
      nextDueDate: summary?.nextDueDate ?? null,
      late: summary?.late ?? false,
      reserveOutstandingPesewas: reserve?.outstanding ?? 0,
      createdAt: plan.created_at,
      installments: schedule.map((s) => ({
        sequence_number: s.sequence_number,
        due_date: s.due_date,
        amount_due_pesewas: s.amount_due_pesewas,
        amount_paid_pesewas: s.amount_paid_pesewas,
        late_fee_pesewas: s.late_fee_pesewas,
        status: s.status,
        paid_at: s.paid_at,
      })),
      settledPesewas: accrual.net,
      mdrPesewas: accrual.mdr,
      reserveWithheldPesewas: accrual.reserve,
      reserveReleasesAt: reserve?.releasesAt ?? null,
      mdrBps: plan.mdr_bps,
      reserveBps: plan.reserve_bps,
    };
  }

  // ----------------------------------------------------------------- internal

  /**
   * The schedule facts every plan card needs, for a whole page in one query.
   *
   * `installments` counts ROWS, which includes the deposit where the plan has
   * one. `number_of_installments` on the plan excludes it, so a "Pay in 4" plan
   * has that field set to 3 and four rows here — a card built on the column
   * would tell the customer they owe one payment fewer than they do.
   */
  private async scheduleSummary(planIds: string[]): Promise<
    Map<
      string,
      {
        collectedPesewas: number;
        paidCount: number;
        installmentCount: number;
        nextDueDate: string | null;
        late: boolean;
      }
    >
  > {
    const out = new Map<
      string,
      {
        collectedPesewas: number;
        paidCount: number;
        installmentCount: number;
        nextDueDate: string | null;
        late: boolean;
      }
    >();
    if (planIds.length === 0) return out;

    const result = await this.db.execute(sql`
      SELECT s.customer_plan_id                                          AS plan_id,
             coalesce(sum(s.amount_paid_pesewas), 0)::text               AS collected,
             count(*) FILTER (WHERE s.status = 'paid')::int              AS paid_count,
             count(*)::int                                              AS installments,
             min(s.due_date) FILTER (
               WHERE s.status NOT IN ('paid', 'waived', 'refunded')
             )::text                                                     AS next_due,
             bool_or(s.status IN (${sql.join(
               LATE_INSTALLMENT_STATUSES.map((status) => sql`${status}`),
               sql`, `,
             )}))                                                        AS late
      FROM installment_schedule s
      WHERE s.customer_plan_id IN (${sql.join(
        planIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY s.customer_plan_id
    `);

    for (const r of result.rows as unknown as PlanAggregateRow[]) {
      out.set(r.plan_id, {
        collectedPesewas: Number(r.collected),
        paidCount: Number(r.paid_count),
        installmentCount: Number(r.installments),
        nextDueDate: r.next_due,
        late: Boolean(r.late),
      });
    }
    return out;
  }

  /** Reserve outstanding per plan, and when the policy lets it move. */
  private async reservesFor(
    planIds: string[],
  ): Promise<Map<string, { outstanding: number; releasesAt: string | null }>> {
    const out = new Map<string, { outstanding: number; releasesAt: string | null }>();
    if (planIds.length === 0) return out;

    const rows = await this.db.select().from(hr).where(inArray(hr.customer_plan_id, planIds));
    for (const r of rows) {
      const current = out.get(r.customer_plan_id) ?? { outstanding: 0, releasesAt: null };
      current.outstanding +=
        r.amount_pesewas - r.released_amount_pesewas - r.consumed_for_default_pesewas;
      // The POLICY's date, not the trigger's — the buffer is per business
      // model and lives in the settlement engine.
      const releaseAt = reserveReleaseDate(r);
      const iso = releaseAt ? releaseAt.toISOString() : null;
      if (iso && (!current.releasesAt || iso > current.releasesAt)) current.releasesAt = iso;
      out.set(r.customer_plan_id, current);
    }
    for (const [id, v] of out) out.set(id, { ...v, outstanding: Math.max(0, v.outstanding) });
    return out;
  }

  /**
   * What the plan's payout accruals actually booked.
   *
   * Summed across every trigger the model fires — bnpl fires once at approval,
   * but hybrid splits 40/60 across the deposit and completion, and the model
   * table permits per-instalment triggers. A read that took the first
   * transaction would under-report a staged plan by most of its value.
   */
  private async accrualFor(
    merchantId: string,
    planId: string,
  ): Promise<{ net: number; mdr: number; reserve: number }> {
    const result = await this.db.execute(sql`
      SELECT coalesce(sum(le.amount_pesewas) FILTER (
               WHERE le.account_type = 'merchant_payable' AND le.direction = 'credit'
             ), 0)::text AS net,
             coalesce(sum(le.amount_pesewas) FILTER (
               WHERE le.account_type = 'revenue' AND le.direction = 'credit'
             ), 0)::text AS mdr,
             coalesce(sum(le.amount_pesewas) FILTER (
               WHERE le.account_type = 'reserve_held' AND le.direction = 'credit'
             ), 0)::text AS reserve
      FROM ledger_entries le
      WHERE le.transaction_id LIKE ${PLAN_ACCRUAL_TX_PREFIX} || ${planId}::text || ':%'
        AND (le.account_type <> 'merchant_payable' OR le.account_ref = ${merchantId})
    `);
    const row = (result.rows as unknown as AccrualRow[])[0];
    return {
      net: Number(row?.net ?? 0),
      mdr: Number(row?.mdr ?? 0),
      reserve: Number(row?.reserve ?? 0),
    };
  }
}

/**
 * `active` and `completed` are statuses; `late` is not.
 *
 * A plan with a missed payment stays `active`, so the late bucket is an EXISTS
 * over the schedule — and it is deliberately NOT restricted to active plans:
 * a defaulted plan carries overdue rows too, and a seller filtering for late
 * money wants to see it.
 */
function bucketFilter(bucket: MerchantPlanBucket) {
  if (bucket === 'active') return eq(cp.status, 'active');
  if (bucket === 'completed') return eq(cp.status, 'completed');
  if (bucket === 'late') {
    return sql`EXISTS (
      SELECT 1 FROM installment_schedule s
      WHERE s.customer_plan_id = ${cp.id}
        AND s.status IN (${sql.join(
          LATE_INSTALLMENT_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})
    )`;
  }
  return undefined;
}

/** `first_name last_name`, or null when the join found nobody. */
const customerName = sql<
  string | null
>`nullif(trim(concat_ws(' ', ${cust.first_name}, ${cust.last_name})), '')`;
