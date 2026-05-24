import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, ExposureSignals } from './types';

const cp = schema.customer_plans;
const ap = schema.applications;
const cust = schema.customers;
const prof = schema.credit_profiles;

const MS_PER_DAY = 86_400_000;

/**
 * Current exposure + velocity — active plan count and outstanding balance from
 * `customer_plans`, 24h application velocity from `applications`, blocklist
 * flag from `customers`, and the most recent approved limit from
 * `credit_profiles`.
 */
export class ExposureCollector implements Collector<ExposureSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<ExposureSignals> {
    const dayAgoIso = new Date(Date.now() - MS_PER_DAY).toISOString();

    const planRows = await this.db
      .select({
        active: sql<string>`count(*) filter (where ${cp.status} = 'active')`,
        outstanding: sql<string>`coalesce(sum(${cp.outstanding_pesewas}) filter (where ${cp.status} = 'active'), 0)`,
      })
      .from(cp)
      .where(eq(cp.customer_id, customerId));

    const appRows = await this.db
      .select({ recent: sql<string>`count(*)` })
      .from(ap)
      .where(and(eq(ap.customer_id, customerId), gte(ap.created_at, dayAgoIso)));

    const custRows = await this.db
      .select({ blocked: cust.is_on_blocklist })
      .from(cust)
      .where(eq(cust.id, customerId))
      .limit(1);

    const profileRows = await this.db
      .select({ approved_limit_pesewas: prof.approved_limit_pesewas })
      .from(prof)
      .where(eq(prof.customer_id, customerId))
      .orderBy(desc(prof.decided_at))
      .limit(1);

    return {
      activePlansCount: Number(planRows[0]!.active),
      outstandingBalanceGhs: Number(planRows[0]!.outstanding) / 100,
      currentLimitGhs: profileRows[0] ? Number(profileRows[0].approved_limit_pesewas) / 100 : 0,
      applicationsLast24h: Number(appRows[0]!.recent),
      isOnBlocklist: custRows[0]?.blocked ?? false,
    };
  }

  defaults(): ExposureSignals {
    return {
      activePlansCount: 0,
      outstandingBalanceGhs: 0,
      currentLimitGhs: 0,
      applicationsLast24h: 0,
      isOnBlocklist: false,
    };
  }
}
