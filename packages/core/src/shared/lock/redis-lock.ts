import { randomUUID } from 'node:crypto';

/**
 * Minimal Redis surface RedisLock needs. ioredis satisfies this structurally;
 * keeping it narrow stops @installment/core depending on a redis client.
 */
export interface RedisLockClient {
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface LockOptions {
  /** Lock auto-expiry in ms (the safety net if a holder dies). Default 10000. */
  ttlMs?: number;
  /** Max time in ms to wait while acquiring before giving up. Default 5000. */
  waitMs?: number;
  /** Delay in ms between acquisition attempts. Default 100. */
  retryDelayMs?: number;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * Releases the lock only if we still own it (our token is still the value).
 * Prevents deleting a lock that expired and was re-acquired by someone else.
 */
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class LockAcquisitionError extends Error {
  constructor(key: string, waitMs: number) {
    super(`Could not acquire lock "${key}" within ${waitMs}ms`);
    this.name = 'LockAcquisitionError';
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Redis distributed lock. Guards a critical section (e.g. a single
 * installment schedule's state transition) so two workers can't race.
 */
export class RedisLock {
  constructor(private readonly redis: RedisLockClient) {}

  /**
   * Acquires `key`, runs `fn`, and always releases — including when `fn`
   * throws (the error propagates unchanged). Throws {@link LockAcquisitionError}
   * if the lock can't be acquired within `opts.waitMs`.
   */
  async withLock<T>(key: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;

    let acquired = false;
    for (;;) {
      const res = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        acquired = true;
        break;
      }
      if (Date.now() + retryDelayMs > deadline) break;
      await delay(retryDelayMs);
    }

    if (!acquired) {
      throw new LockAcquisitionError(key, waitMs);
    }

    try {
      return await fn();
    } finally {
      // Best-effort: if this fails the TTL still expires the lock. Swallow so
      // a release error never masks fn's result or error.
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    }
  }
}
