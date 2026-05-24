import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, IdentitySignals } from './types';
import { daysBetween, yearsBetween } from './time';

const c = schema.customers;

/** Identity signals — sourced from the `customers` row. */
export class IdentityCollector implements Collector<IdentitySignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<IdentitySignals> {
    const rows = await this.db
      .select({
        ghana_card_verified: c.ghana_card_verified,
        kyc_tier: c.kyc_tier,
        phone_first_seen_at: c.phone_first_seen_at,
        date_of_birth: c.date_of_birth,
      })
      .from(c)
      .where(eq(c.id, customerId))
      .limit(1);
    const row = rows[0];
    if (!row) return this.defaults();

    const now = new Date();
    return {
      ghanaCardVerified: row.ghana_card_verified,
      // Phone-verification + address-proof are not captured on customers yet.
      phoneVerified: false,
      phoneAgeDays: daysBetween(new Date(row.phone_first_seen_at), now),
      addressProofUploaded: false,
      kycTier: row.kyc_tier as IdentitySignals['kycTier'],
      ageYears: row.date_of_birth ? yearsBetween(new Date(row.date_of_birth), now) : null,
    };
  }

  defaults(): IdentitySignals {
    return {
      ghanaCardVerified: false,
      phoneVerified: false,
      phoneAgeDays: 0,
      addressProofUploaded: false,
      kycTier: 0,
      ageYears: null,
    };
  }
}
