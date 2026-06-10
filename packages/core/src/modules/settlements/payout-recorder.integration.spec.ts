import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@installment/db';
import { LedgerService } from '../../shared/ledger/ledger.service';
import { PLATFORM_ACCOUNT_REF, PayoutRecorder } from './payout-recorder';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('PayoutRecorder (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const ledger = new LedgerService(db);
  const recorder = new PayoutRecorder(db, ledger);

  let merchantId: string;
  let planId: string;

  beforeAll(() => {
    // We don't need real merchants / customer_plans rows — the ledger's
    // accountRef columns are TEXT with no FK constraints. Using random UUIDs
    // isolates each test run's balances from prior data.
    merchantId = randomUUID();
    planId = randomUUID();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('books a balanced four-entry transaction for BNPL on order_approved', async () => {
    // Revenue account_ref is the global PLATFORM_ACCOUNT_REF, so other tests in
    // the suite contribute to it. Snapshot and assert a delta of 4_000.
    const revenueBefore = await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF);

    const breakdown = await recorder.recordPayoutAccrual({
      customerPlanId: planId,
      merchantId,
      orderAmountPesewas: 100_000,
      model: 'bnpl',
      trigger: 'order_approved',
    });

    expect(breakdown).toEqual({
      grossPesewas: 100_000,
      mdrPesewas: 4_000,
      reservePesewas: 5_000,
      netPesewas: 91_000,
      platformRevenuePesewas: 4_000,
    });

    // Per-merchant / per-plan balances are isolated; the global revenue moved by +4_000.
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000);
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(revenueBefore + 4_000);
    expect(await ledger.balanceOf('reserve_held', planId)).toBe(5_000);
    expect(await ledger.balanceOf('receivable', planId)).toBe(-100_000); // debit-side

    const rows = await db
      .select()
      .from(schema.ledger_entries)
      .where(eq(schema.ledger_entries.transaction_id, `accrue:${planId}:order_approved`));
    expect(rows).toHaveLength(4);
  });

  it('is idempotent — replaying the same trigger does not double-book', async () => {
    const replay = await recorder.recordPayoutAccrual({
      customerPlanId: planId,
      merchantId,
      orderAmountPesewas: 100_000,
      model: 'bnpl',
      trigger: 'order_approved',
    });
    expect(replay).not.toBeNull();
    expect(await ledger.balanceOf('merchant_payable', merchantId)).toBe(91_000); // unchanged
  });

  it('books both slices of a hybrid plan in order (40% then 60%)', async () => {
    const hybridMerchant = randomUUID();
    const hybridPlan = randomUUID();
    const order = 100_000;

    const down = await recorder.recordPayoutAccrual({
      customerPlanId: hybridPlan,
      merchantId: hybridMerchant,
      orderAmountPesewas: order,
      model: 'hybrid',
      trigger: 'down_payment_received',
    });
    const completed = await recorder.recordPayoutAccrual({
      customerPlanId: hybridPlan,
      merchantId: hybridMerchant,
      orderAmountPesewas: order,
      model: 'hybrid',
      trigger: 'plan_completed',
    });

    expect(down!.grossPesewas).toBe(40_000);
    expect(completed!.grossPesewas).toBe(60_000);
    expect(await ledger.balanceOf('merchant_payable', hybridMerchant)).toBe(
      down!.netPesewas + completed!.netPesewas,
    );
    expect(await ledger.balanceOf('reserve_held', hybridPlan)).toBe(
      down!.reservePesewas + completed!.reservePesewas,
    );
    expect(await ledger.balanceOf('receivable', hybridPlan)).toBe(-order);
  });

  it('returns null and books nothing for a trigger the model does not pay out on', async () => {
    const otherMerchant = randomUUID();
    const otherPlan = randomUUID();
    const result = await recorder.recordPayoutAccrual({
      customerPlanId: otherPlan,
      merchantId: otherMerchant,
      orderAmountPesewas: 100_000,
      model: 'bnpl',
      trigger: 'plan_completed', // BNPL has no plan_completed split
    });
    expect(result).toBeNull();
    expect(await ledger.balanceOf('merchant_payable', otherMerchant)).toBe(0);
  });
});
