import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { count, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createTestDb, schema, testDatabaseUrl } from '@installment/db';
import { LedgerService } from './ledger.service';
import { PLATFORM_ACCOUNT_REF } from '../../modules/settlements/payout-recorder';
import { SETTLEMENT_CASH_REF } from '../../modules/settlements/settlement.service';
import { SYSTEM_ACTORS } from '../constants/system-actors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * S15 — the isolation the rest of the suite now depends on.
 *
 * Until this landed, every integration spec opened the same database and
 * nothing ever cleaned up. The consequences were not theoretical:
 *
 *   - An assertion on `paystack_settlement['main']` passed locally against a
 *     database that had accumulated collections from earlier runs, and failed in
 *     CI against a clean one. That happened three times in one slice.
 *   - A sweep scoped to "every overdue schedule" pulled ~2,600 rows other specs
 *     had left behind and timed out.
 *   - Re-running the suite locally failed on unique constraints, because the
 *     previous run's rows were still there.
 *
 * These assertions are the contract that makes those bugs impossible. They are
 * deliberately about the *harness*, not the domain: if they fail, every other
 * integration result in the repo is suspect.
 */
describe.skipIf(!RUN_DB)('Integration test isolation', () => {
  const { db, pool } = createTestDb();
  const ledger = new LedgerService(db);

  afterAll(async () => {
    await pool.end();
  });

  async function countRows(table: PgTable): Promise<number> {
    const rows = await db.select({ n: count() }).from(table);
    return Number(rows[0]?.n ?? -1);
  }

  it('runs against this worker’s own database, not the shared one', () => {
    // Parallel spec files land in different workers; each gets its own clone,
    // so one file's sweep can never see another's rows.
    expect(testDatabaseUrl()).toMatch(/_w\d+(\?|$)/);
    expect(testDatabaseUrl()).not.toBe(process.env.DATABASE_URL);
  });

  it('starts every file with the global ledger accounts at zero', async () => {
    // These account refs are shared by every plan in the system, so their
    // balances are exactly what a dirty database corrupts first. Asserting on
    // them was previously meaningless — this is what makes it mean something.
    expect(await ledger.balanceOf('paystack_settlement', SETTLEMENT_CASH_REF)).toBe(0);
    expect(await ledger.balanceOf('default_pool', SETTLEMENT_CASH_REF)).toBe(0);
    expect(await ledger.balanceOf('revenue', PLATFORM_ACCOUNT_REF)).toBe(0);

    expect(await countRows(schema.ledger_entries)).toBe(0);
  });

  it('starts every file with no transactional rows at all', async () => {
    for (const table of [
      schema.customer_plans,
      schema.installment_schedule,
      schema.payment_attempts,
      schema.applications,
      schema.merchants,
      schema.customers,
      schema.payouts,
      schema.refunds,
      schema.held_reserves,
      schema.audit_events,
    ]) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it('keeps the seeded reference data the whole suite assumes', async () => {
    // Truncating these would break every spec: RBAC checks resolve permission
    // names, and audit rows are stamped with SYSTEM_ACTORS ids.
    expect(await countRows(schema.permissions)).toBeGreaterThan(0);
    expect(await countRows(schema.roles)).toBeGreaterThan(0);

    const systemActor = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, SYSTEM_ACTORS.SYSTEM));
    expect(systemActor).toHaveLength(1);
  });

  it('resets the append-only tables without weakening the trigger that guards them', async () => {
    // The reset uses TRUNCATE, which does not fire row-level triggers. DELETE
    // must still be refused — if this ever passes, the cleanup has been
    // "fixed" by dropping the guarantee the production ledger relies on.
    const transactionId = `isolation-check:${randomUUID()}`;
    await ledger.record([
      {
        transactionId,
        accountType: 'revenue',
        accountRef: PLATFORM_ACCOUNT_REF,
        direction: 'credit',
        amountPesewas: 1,
        description: 'isolation probe',
      },
      {
        transactionId,
        accountType: 'receivable',
        accountRef: randomUUID(),
        direction: 'debit',
        amountPesewas: 1,
        description: 'isolation probe',
      },
    ]);

    await expect(
      db.execute(sql`DELETE FROM ledger_entries WHERE transaction_id = ${transactionId}`),
    ).rejects.toThrow();
  });
});
