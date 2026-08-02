import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '@installment/db';
import { LedgerService } from './ledger.service';
import { LedgerIntegrityService } from './ledger-integrity.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('LedgerIntegrityService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const ledger = new LedgerService(db);
  const integrity = new LedgerIntegrityService(db);

  afterAll(async () => {
    await pool.end();
  });

  /** Writes a balanced transaction through the normal path. */
  async function balancedTransaction(amount: number): Promise<string> {
    const transactionId = `integrity-ok-${randomUUID()}`;
    const ref = randomUUID();
    await ledger.record([
      {
        transactionId,
        accountType: 'receivable',
        accountRef: ref,
        direction: 'debit',
        amountPesewas: amount,
        description: 'test debit',
      },
      {
        transactionId,
        accountType: 'merchant_payable',
        accountRef: ref,
        direction: 'credit',
        amountPesewas: amount,
        description: 'test credit',
      },
    ]);
    return transactionId;
  }

  it('reports a trial balance covering every account type in use', async () => {
    await balancedTransaction(10_000);
    const tb = await integrity.trialBalance();

    expect(tb.rows.length).toBeGreaterThan(0);
    for (const row of tb.rows) {
      // balance = credits - debits, per the ledger's convention.
      expect(row.balancePesewas).toBe(row.creditsPesewas - row.debitsPesewas);
    }
  });

  it('does not flag a transaction written through LedgerService.record', async () => {
    const transactionId = await balancedTransaction(25_000);
    const found = await integrity.findUnbalancedTransactions();
    expect(found.map((t) => t.transactionId)).not.toContain(transactionId);
  });

  it('detects a transaction whose debits and credits disagree', async () => {
    // The bad row is written with raw SQL deliberately: LedgerService.record
    // would reject it. The detector exists precisely for postings that did not
    // come through it — an older code path, a hand-run fix, a future bug.
    //
    // It is written inside a transaction that is then rolled back, because
    // ledger_entries is append-only: the DELETE a normal cleanup would use is
    // blocked by the immutability trigger, so an artifact written here would
    // pollute every later run of the shared test database permanently.
    const transactionId = `integrity-bad-${randomUUID()}`;
    class Rollback extends Error {}
    let found: Awaited<ReturnType<typeof integrity.findUnbalancedTransactions>> = [];
    let healthy = true;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO ledger_entries (transaction_id, account_type, account_ref, direction, amount_pesewas, description)
          VALUES (${transactionId}, 'receivable', ${randomUUID()}, 'debit', 5000, 'orphan debit')
        `);
        const scoped = new LedgerIntegrityService(tx as unknown as typeof db);
        found = await scoped.findUnbalancedTransactions();
        healthy = (await scoped.report()).healthy;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    // Asserted outside the transaction so a failure reports as itself rather
    // than being swallowed by the rollback.
    const mine = found.find((t) => t.transactionId === transactionId);
    expect(mine).toBeDefined();
    expect(mine!.debitsPesewas).toBe(5_000);
    expect(mine!.creditsPesewas).toBe(0);
    expect(mine!.driftPesewas).toBe(-5_000);
    expect(healthy).toBe(false);

    // And the artifact really is gone.
    const after = await integrity.findUnbalancedTransactions();
    expect(after.map((t) => t.transactionId)).not.toContain(transactionId);
  });

  it('cannot delete a ledger row — the record is append-only', async () => {
    const transactionId = await balancedTransaction(1_000);
    await expect(
      db.execute(sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`),
    ).rejects.toThrow();
  });

  it('bounds how many offenders it returns', async () => {
    const found = await integrity.findUnbalancedTransactions(1);
    expect(found.length).toBeLessThanOrEqual(1);
  });

  it('report() combines both checks and stamps the time', async () => {
    const at = new Date('2026-08-02T10:00:00.000Z');
    const report = await integrity.report(at);
    expect(report.checkedAt).toBe(at.toISOString());
    expect(report.trialBalance.rows).toBeDefined();
    expect(Array.isArray(report.unbalancedTransactions)).toBe(true);
    expect(report.healthy).toBe(
      report.trialBalance.balanced && report.unbalancedTransactions.length === 0,
    );
  });
});
