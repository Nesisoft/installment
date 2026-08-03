import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { and, eq } from 'drizzle-orm';
import { runInTransaction } from './transaction';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('runInTransaction (integration)', () => {
  const { db, pool } = createTestDb();
  const ledger = schema.ledger_entries;

  afterAll(async () => {
    await pool.end();
  });

  const countFor = async (ref: string): Promise<number> => {
    const rows = await db
      .select({ id: ledger.id })
      .from(ledger)
      .where(and(eq(ledger.account_ref, ref), eq(ledger.account_type, 'revenue')));
    return rows.length;
  };

  it('commits work done through the proxied tx and fires afterCommit after', async () => {
    const ref = `txn-int-${randomUUID()}`;
    const hook = vi.fn();

    const result = await runInTransaction(db, async (tx) => {
      await tx.insert(ledger).values({
        transaction_id: ref,
        account_type: 'revenue',
        account_ref: ref,
        direction: 'credit',
        amount_pesewas: 1234,
        description: 'afterCommit integration',
      });
      tx.afterCommit(() => hook(ref));
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(hook).toHaveBeenCalledWith(ref);
    expect(await countFor(ref)).toBe(1);
  });

  it('rolls back the insert and skips afterCommit when fn throws', async () => {
    const ref = `txn-int-${randomUUID()}`;
    const hook = vi.fn();

    await expect(
      runInTransaction(db, async (tx) => {
        await tx.insert(ledger).values({
          transaction_id: ref,
          account_type: 'revenue',
          account_ref: ref,
          direction: 'credit',
          amount_pesewas: 999,
          description: 'should roll back',
        });
        tx.afterCommit(hook);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    expect(hook).not.toHaveBeenCalled();
    expect(await countFor(ref)).toBe(0);
  });
});
