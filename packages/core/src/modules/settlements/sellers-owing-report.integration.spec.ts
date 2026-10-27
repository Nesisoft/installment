import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from '../merchants/merchants.service';
import { SellersOwingReport } from './sellers-owing-report';

const RUN_DB = Boolean(process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

describe.skipIf(!RUN_DB)('SellersOwingReport (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const report = new SellersOwingReport(db);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const NOW = new Date('2026-10-27T08:00:00Z');

  afterAll(async () => {
    await pool.end();
  });

  async function merchant(status: 'active' | 'offboarded' = 'active', onboardedDaysAgo = 200) {
    const suffix = randomUUID();
    const m = await merchants.create(
      {
        business_name: `Owing ${suffix}`,
        legal_name: `Owing Ltd ${suffix}`,
        email: `owing+${suffix}@x.gh`,
        phone: '+233244000000',
      },
      ACTOR,
    );
    await db
      .update(schema.merchants)
      .set({
        status,
        onboarded_at: new Date(NOW.getTime() - onboardedDaysAgo * DAY_MS).toISOString(),
      })
      .where(eq(schema.merchants.id, m.id));
    return m.id;
  }

  /**
   * A balanced movement on the merchant's payable at a chosen instant: credit
   * for a sale, debit for a return. The other leg is cash, so the books stay
   * balanced for every other spec that sums them.
   */
  async function book(
    merchantId: string,
    prefix: 'sale' | 'order-return',
    direction: 'credit' | 'debit',
    amount: number,
    daysAgo = 1,
  ) {
    const transactionId = `${prefix}:${randomUUID()}`;
    const occurredAt = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
    await db.insert(schema.ledger_entries).values([
      {
        transaction_id: transactionId,
        account_type: 'merchant_payable',
        account_ref: merchantId,
        direction,
        amount_pesewas: amount,
        description: 'test',
        occurred_at: occurredAt,
      },
      {
        transaction_id: transactionId,
        account_type: 'paystack_settlement',
        account_ref: 'test-cash',
        direction: direction === 'credit' ? 'debit' : 'credit',
        amount_pesewas: amount,
        description: 'test',
        occurred_at: occurredAt,
      },
    ]);
  }

  it('lists only sellers who owe, the ones nothing nets off first', async () => {
    const square = await merchant();
    await book(square, 'sale', 'credit', 50_000);

    // Paid out 40,000 of a 40,000 sale, then a 25,000 return: owes 25,000.
    const owing = await merchant('active', 12);
    await book(owing, 'sale', 'credit', 40_000, 20);
    await book(owing, 'sale', 'debit', 40_000, 19); // the payout's debit
    await db.insert(schema.payouts).values({
      merchant_id: owing,
      amount_pesewas: 40_000,
      as_of_date: '2026-10-08',
      reference: `payout:${owing}:2026-10-08`,
      status: 'settled',
      settled_at: new Date(NOW.getTime() - 19 * DAY_MS).toISOString(),
    });
    await book(owing, 'order-return', 'debit', 25_000, 3);
    // A return older than 90 days is in the balance but not the recent count.
    await book(owing, 'sale', 'credit', 5_000, 120);
    await book(owing, 'order-return', 'debit', 5_000, 100);

    // Offboarded and owing a little: still first, because nothing nets it off.
    const gone = await merchant('offboarded');
    await book(gone, 'sale', 'credit', 10_000, 40);
    await book(gone, 'order-return', 'debit', 12_000, 10);

    const rows = (await report.list(NOW)).filter((r) =>
      [square, owing, gone].includes(r.merchant_id),
    );

    expect(rows.map((r) => r.merchant_id)).toEqual([gone, owing]);
    expect(rows[0]).toMatchObject({
      status: 'offboarded',
      owed_pesewas: 2_000,
      unrecoverable: true,
    });
    expect(rows[1]).toMatchObject({
      status: 'active',
      owed_pesewas: 25_000,
      unrecoverable: false,
      seller_age_days: 12,
      returns_90d_pesewas: 25_000,
      returns_90d_count: 1,
      last_payout_pesewas: 40_000,
    });
    expect(rows[1]!.last_payout_at).toBe(new Date(NOW.getTime() - 19 * DAY_MS).toISOString());

    const summary = report.summarise(rows);
    expect(summary).toEqual({
      sellers: 2,
      owed_pesewas: 27_000,
      unrecoverable_sellers: 1,
      unrecoverable_pesewas: 2_000,
      new_sellers: 1,
    });
  });
});
