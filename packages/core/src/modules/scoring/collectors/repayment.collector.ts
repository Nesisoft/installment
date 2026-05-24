import { desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, RepaymentSignals } from './types';
import { daysBetween } from './time';

const cp = schema.customer_plans;
const sched = schema.installment_schedule;

/** Installment statuses that count as resolved for streak purposes. */
const RESOLVED = new Set(['paid', 'overdue', 'in_collections', 'defaulted']);

/**
 * Repayment history — aggregated from `customer_plans` (completed/defaulted
 * counts) and `installment_schedule` (on-time rate, days-past-due, streak).
 */
export class RepaymentCollector implements Collector<RepaymentSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<RepaymentSignals> {
    const now = new Date();
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setUTCFullYear(now.getUTCFullYear() - 1);
    const twelveAgoIso = twelveMonthsAgo.toISOString();

    const planRows = await this.db
      .select({
        completed: sql<string>`count(*) filter (where ${cp.status} = 'completed')`,
        defaultsAllTime: sql<string>`count(*) filter (where ${cp.status} = 'defaulted')`,
        defaults12mo: sql<string>`count(*) filter (where ${cp.status} = 'defaulted' and ${cp.defaulted_at} >= ${twelveAgoIso})`,
      })
      .from(cp)
      .where(eq(cp.customer_id, customerId));
    const agg = planRows[0]!;

    const installments = await this.db
      .select({
        status: sched.status,
        due_date: sched.due_date,
        grace_until_date: sched.grace_until_date,
        paid_at: sched.paid_at,
      })
      .from(sched)
      .innerJoin(cp, eq(sched.customer_plan_id, cp.id))
      .where(eq(cp.customer_id, customerId))
      .orderBy(desc(sched.due_date));

    let paidCount = 0;
    let onTimeCount = 0;
    let pastDueTotal = 0;
    for (const i of installments) {
      if (i.status !== 'paid') continue;
      paidCount++;
      if (paidOnTime(i.grace_until_date, i.paid_at)) onTimeCount++;
      if (i.paid_at) pastDueTotal += daysBetween(new Date(i.due_date), new Date(i.paid_at));
    }

    // Most-recent-first: count the leading run of on-time paid installments,
    // stopping at the first missed (overdue/defaulted) one.
    let consecutiveOnTime = 0;
    for (const i of installments) {
      if (!RESOLVED.has(i.status)) continue;
      if (i.status === 'paid' && paidOnTime(i.grace_until_date, i.paid_at)) consecutiveOnTime++;
      else break;
    }

    return {
      completedPlansCount: Number(agg.completed),
      onTimePaymentRate: paidCount > 0 ? onTimeCount / paidCount : 1,
      averageDaysPastDue: paidCount > 0 ? pastDueTotal / paidCount : 0,
      priorDefaults12mo: Number(agg.defaults12mo),
      priorDefaultsAllTime: Number(agg.defaultsAllTime),
      consecutiveOnTime,
    };
  }

  defaults(): RepaymentSignals {
    // Neutral thin-file: no history, no defaults. A transient outage here
    // reads as a brand-new customer rather than auto-declining or approving.
    return {
      completedPlansCount: 0,
      onTimePaymentRate: 1,
      averageDaysPastDue: 0,
      priorDefaults12mo: 0,
      priorDefaultsAllTime: 0,
      consecutiveOnTime: 0,
    };
  }
}

/** On time iff paid on/before the grace date (UTC date comparison). */
function paidOnTime(graceUntilDate: string, paidAt: string | null): boolean {
  if (!paidAt) return false;
  return paidAt.slice(0, 10) <= graceUntilDate;
}
