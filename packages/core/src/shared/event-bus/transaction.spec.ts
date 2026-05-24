import { describe, expect, it, vi } from 'vitest';
import { runInTransaction } from './transaction';

/** Fake that mimics Drizzle: runs the callback, "commits" by resolving. */
function fakeDb(tx: object) {
  return {
    transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  } as never;
}

describe('runInTransaction', () => {
  it('returns the callback result and runs afterCommit hooks after commit, in order', async () => {
    const events: string[] = [];
    const db = fakeDb({});

    const result = await runInTransaction(db, async (tx) => {
      tx.afterCommit(() => {
        events.push('after-1');
      });
      tx.afterCommit(async () => {
        await Promise.resolve();
        events.push('after-2');
      });
      events.push('work');
      return 'RESULT';
    });

    expect(result).toBe('RESULT');
    expect(events).toEqual(['work', 'after-1', 'after-2']);
  });

  it('forwards property/method access to the underlying tx', async () => {
    const ping = vi.fn((n: number) => n + 1);
    const db = fakeDb({ ping });

    const out = await runInTransaction(db, async (tx) => {
      return (tx as unknown as { ping(n: number): number }).ping(41);
    });

    expect(out).toBe(42);
    expect(ping).toHaveBeenCalledWith(41);
  });

  it('does not run afterCommit hooks when the transaction rolls back', async () => {
    const hook = vi.fn();
    // Drizzle rejects (rolls back) when the callback throws.
    const db = {
      transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb({})),
    } as never;

    await expect(
      runInTransaction(db, async (tx) => {
        tx.afterCommit(hook);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(hook).not.toHaveBeenCalled();
  });

  it('isolates a throwing afterCommit hook from the others and the result', async () => {
    const second = vi.fn();
    const db = fakeDb({});

    const result = await runInTransaction(db, async (tx) => {
      tx.afterCommit(() => {
        throw new Error('hook boom');
      });
      tx.afterCommit(second);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(second).toHaveBeenCalledTimes(1);
  });
});
