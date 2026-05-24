import type { Database } from '@installment/db';

/** The transaction client Drizzle hands to a `db.transaction(...)` callback. */
export type TxClient = Parameters<Parameters<Database['transaction']>[0]>[0];

export type AfterCommitFn = () => void | Promise<void>;

export interface AfterCommitHook {
  /**
   * Queue a callback to run only after the surrounding transaction COMMITS.
   * Domain events must be published here, never inside the transaction.
   */
  afterCommit(fn: AfterCommitFn): void;
}

/** The Drizzle tx augmented with the {@link AfterCommitHook}. */
export type TransactionalTx = TxClient & AfterCommitHook;

/**
 * Runs `fn` inside a DB transaction and exposes `tx.afterCommit(cb)`. Queued
 * callbacks fire only if the transaction commits; if `fn` throws the
 * transaction rolls back and no callback runs. After-commit callbacks are
 * best-effort and isolated — one throwing does not affect the others or the
 * (already committed) result.
 */
export async function runInTransaction<T>(
  db: Pick<Database, 'transaction'>,
  fn: (tx: TransactionalTx) => Promise<T>,
): Promise<T> {
  const queued: AfterCommitFn[] = [];

  const result = await db.transaction(async (tx) => {
    const proxied = new Proxy(tx as object, {
      get(target, prop, receiver) {
        if (prop === 'afterCommit') {
          return (cb: AfterCommitFn) => {
            queued.push(cb);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as unknown as TransactionalTx;

    return fn(proxied);
  });

  for (const cb of queued) {
    try {
      await cb();
    } catch {
      // Post-commit hooks are best-effort: the transaction already committed,
      // so a failing hook must not surface as a transaction failure.
    }
  }

  return result;
}
