import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { LedgerService } from './ledger.service';

/**
 * Real-database round trip. Skipped automatically when DATABASE_URL is unset
 * (e.g. CI without a Postgres service), so the unit suite stays hermetic.
 */
const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('LedgerService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const ledger = new LedgerService(db);

  afterAll(async () => {
    await pool.end();
  });

  it('persists a balanced transaction and reports the running balance', async () => {
    const merchantRef = `merchant-${randomUUID()}`;
    const planRef = `plan-${randomUUID()}`;
    const txn = `accrue:${planRef}:order_approved`;

    const returned = await ledger.record([
      {
        transactionId: txn,
        accountType: 'receivable',
        accountRef: planRef,
        direction: 'debit',
        amountPesewas: 100_000,
        description: 'Receivable for plan',
      },
      {
        transactionId: txn,
        accountType: 'merchant_payable',
        accountRef: merchantRef,
        direction: 'credit',
        amountPesewas: 91_000,
        description: 'Net payout owed to merchant',
      },
      {
        transactionId: txn,
        accountType: 'reserve_held',
        accountRef: merchantRef,
        direction: 'credit',
        amountPesewas: 5_000,
        description: 'Reserve withheld',
      },
      {
        transactionId: txn,
        accountType: 'revenue',
        accountRef: 'platform',
        direction: 'credit',
        amountPesewas: 4_000,
        description: 'MDR earned',
      },
    ]);

    expect(returned).toBe(txn);
    expect(await ledger.balanceOf('merchant_payable', merchantRef)).toBe(91_000);
    expect(await ledger.balanceOf('reserve_held', merchantRef)).toBe(5_000);

    // Settle: debit the payable back down to zero.
    await ledger.record([
      {
        transactionId: `settle:${merchantRef}`,
        accountType: 'merchant_payable',
        accountRef: merchantRef,
        direction: 'debit',
        amountPesewas: 91_000,
        description: 'Daily settlement',
      },
      {
        transactionId: `settle:${merchantRef}`,
        accountType: 'paystack_settlement',
        accountRef: 'main',
        direction: 'credit',
        amountPesewas: 91_000,
        description: 'Transfer to merchant',
      },
    ]);

    expect(await ledger.balanceOf('merchant_payable', merchantRef)).toBe(0);
  });

  it('writes nothing when the transaction is unbalanced', async () => {
    const ref = `plan-${randomUUID()}`;
    await expect(
      ledger.record([
        {
          transactionId: `bad:${ref}`,
          accountType: 'receivable',
          accountRef: ref,
          direction: 'debit',
          amountPesewas: 100,
          description: 'debit',
        },
        {
          transactionId: `bad:${ref}`,
          accountType: 'revenue',
          accountRef: ref,
          direction: 'credit',
          amountPesewas: 90,
          description: 'credit',
        },
      ]),
    ).rejects.toThrow(/Unbalanced/);

    expect(await ledger.balanceOf('receivable', ref)).toBe(0);
  });
});
