import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, BehaviorSignals } from './types';

const pa = schema.payment_attempts;
const cp = schema.customer_plans;

const MS_PER_DAY = 86_400_000;

/**
 * Payment behavior — aggregated from `payment_attempts` joined to the
 * customer's plans. Successful charges build history; the 90-day failure rate
 * penalizes recent instability.
 */
export class BehaviorCollector implements Collector<BehaviorSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<BehaviorSignals> {
    const ninetyAgoIso = new Date(Date.now() - 90 * MS_PER_DAY).toISOString();

    const rows = await this.db
      .select({
        succeeded: sql<string>`count(*) filter (where ${pa.status} = 'succeeded')`,
        momo: sql<string>`count(*) filter (where ${pa.status} = 'succeeded' and ${pa.payment_method} = 'momo')`,
        avgAmount: sql<string>`coalesce(avg(${pa.amount_pesewas}) filter (where ${pa.status} = 'succeeded'), 0)`,
        failed90: sql<string>`count(*) filter (where ${pa.status} = 'failed' and ${pa.initiated_at} >= ${ninetyAgoIso})`,
        succeeded90: sql<string>`count(*) filter (where ${pa.status} = 'succeeded' and ${pa.initiated_at} >= ${ninetyAgoIso})`,
      })
      .from(pa)
      .innerJoin(cp, eq(pa.customer_plan_id, cp.id))
      .where(eq(cp.customer_id, customerId));
    const r = rows[0]!;

    const succeeded = Number(r.succeeded);
    const failed90 = Number(r.failed90);
    const attempts90 = failed90 + Number(r.succeeded90);

    return {
      paystackTransactionCount: succeeded,
      momoTransactionShare: succeeded > 0 ? Number(r.momo) / succeeded : 0,
      averageTransactionGhs: Number(r.avgAmount) / 100,
      failedChargeRate90d: attempts90 > 0 ? failed90 / attempts90 : 0,
    };
  }

  defaults(): BehaviorSignals {
    return {
      paystackTransactionCount: 0,
      momoTransactionShare: 0,
      averageTransactionGhs: 0,
      failedChargeRate90d: 0,
    };
  }
}
