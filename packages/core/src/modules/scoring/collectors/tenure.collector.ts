import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, TenureSignals } from './types';
import { daysBetween } from './time';

const c = schema.customers;

/**
 * Account tenure — account age from `customers.created_at`. Login + device
 * telemetry are not captured yet and default to absent.
 */
export class TenureCollector implements Collector<TenureSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<TenureSignals> {
    const rows = await this.db
      .select({ created_at: c.created_at })
      .from(c)
      .where(eq(c.id, customerId))
      .limit(1);
    const row = rows[0];
    if (!row) return this.defaults();

    return {
      accountAgeDays: daysBetween(new Date(row.created_at), new Date()),
      loginsLast30Days: 0,
      deviceFingerprintKnown: false,
      distinctDevicesLast90Days: 0,
    };
  }

  defaults(): TenureSignals {
    return {
      accountAgeDays: 0,
      loginsLast30Days: 0,
      deviceFingerprintKnown: false,
      distinctDevicesLast90Days: 0,
    };
  }
}
