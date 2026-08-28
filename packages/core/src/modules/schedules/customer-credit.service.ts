import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';

const standing = schema.customer_credit_standing;
const cp = schema.customer_plans;
const sched = schema.installment_schedule;
const profiles = schema.credit_profiles;

export interface CreditStanding {
  /** The most that may be outstanding across a customer's live plans at once. */
  approved_limit_pesewas: number;
  /** Sum of what their active plans still owe. */
  in_use_pesewas: number;
  /** What is left to spend — never negative, even after a limit is cut. */
  available_pesewas: number;
  on_time_payments: number;
  late_payments: number;
  /** Instalments settled so far, on time or not. */
  total_payments: number;
  active_plans: number;
  /** Whether a limit has ever been set — false means "never scored". */
  has_limit: boolean;
  last_reviewed_at: string | null;
}

/** Plan statuses that still tie up limit. */
const LIVE_PLAN_STATUSES = ['active', 'in_arrears', 'restructured'] as const;

/**
 * What a customer can see about their own credit: their limit, how much of it
 * is committed, and their repayment record.
 *
 * `credit_profiles` is an immutable decision log — one row per scoring run — so
 * a running counter cannot live there. `customer_credit_standing` is the
 * mutable companion: one row per customer, updated as instalments settle. That
 * split keeps the evidence behind a decision tamper-proof while still giving
 * the Wallet screen a number that moves.
 *
 * "In use" is computed from live plans rather than stored, because a stored
 * total is a second source of truth for money that the plans already know, and
 * the two would drift the first time a refund reopened a completed plan.
 */
export class CustomerCreditService {
  constructor(private readonly db: Database) {}

  async forCustomer(customerId: string): Promise<CreditStanding> {
    const [standingRows, planRows, paymentRows] = await Promise.all([
      this.db.select().from(standing).where(eq(standing.customer_id, customerId)).limit(1),
      this.db
        .select({
          outstanding: sql<number>`COALESCE(SUM(${cp.outstanding_pesewas}), 0)::bigint`,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(cp)
        .where(and(eq(cp.customer_id, customerId), inArray(cp.status, [...LIVE_PLAN_STATUSES]))),
      this.db
        .select({
          on_time: sql<number>`COUNT(*) FILTER (WHERE ${sched.paid_at} IS NOT NULL
            AND ${sched.paid_at}::date <= ${sched.grace_until_date})::int`,
          late: sql<number>`COUNT(*) FILTER (WHERE ${sched.paid_at} IS NOT NULL
            AND ${sched.paid_at}::date > ${sched.grace_until_date})::int`,
        })
        .from(sched)
        .innerJoin(cp, eq(cp.id, sched.customer_plan_id))
        .where(and(eq(cp.customer_id, customerId), eq(sched.status, 'paid'))),
    ]);

    const row = standingRows[0];
    const plans = planRows[0];
    const payments = paymentRows[0];

    // A customer scored before this table existed has decisions but no standing
    // row; fall back to their latest decision so the limit is not shown as zero
    // to someone who has one.
    let limit = row?.approved_limit_pesewas ?? 0;
    let reviewedAt = row?.limit_reviewed_at ?? null;
    let hasLimit = row !== undefined;
    if (!row) {
      const latest = await this.db
        .select({ limit: profiles.approved_limit_pesewas, at: profiles.decided_at })
        .from(profiles)
        .where(eq(profiles.customer_id, customerId))
        .orderBy(desc(profiles.decided_at))
        .limit(1);
      if (latest[0]) {
        limit = Number(latest[0].limit);
        reviewedAt = latest[0].at;
        hasLimit = true;
      }
    }

    const inUse = Number(plans?.outstanding ?? 0);
    const onTime = payments?.on_time ?? 0;
    const late = payments?.late ?? 0;

    return {
      approved_limit_pesewas: Number(limit),
      in_use_pesewas: inUse,
      // A limit can be cut below what is already drawn; clamping at zero avoids
      // telling a customer they have negative headroom.
      available_pesewas: Math.max(0, Number(limit) - inUse),
      on_time_payments: onTime,
      late_payments: late,
      total_payments: onTime + late,
      active_plans: plans?.count ?? 0,
      has_limit: hasLimit,
      last_reviewed_at: reviewedAt,
    };
  }

  /**
   * Records the limit a scoring run approved, so the customer's own view moves
   * when a decision does. Called by the scoring path, not by the app.
   */
  async recordDecision(
    customerId: string,
    approvedLimitPesewas: number,
    decisionId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db
      .insert(standing)
      .values({
        customer_id: customerId,
        approved_limit_pesewas: approvedLimitPesewas,
        last_decision_id: decisionId,
        limit_reviewed_at: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: standing.customer_id,
        set: {
          approved_limit_pesewas: approvedLimitPesewas,
          last_decision_id: decisionId,
          limit_reviewed_at: now.toISOString(),
        },
      });
  }
}
