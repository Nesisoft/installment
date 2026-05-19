import { describe, expect, it, vi } from 'vitest';
import { LockAcquisitionError, RedisLock, type RedisLockClient } from './redis-lock';

/** In-memory Redis faithful to SET NX PX and the compare-and-delete release. */
class FakeRedis implements RedisLockClient {
  store = new Map<string, { value: string; expireAt: number }>();

  set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    const existing = this.store.get(key);
    if (existing && existing.expireAt > Date.now()) {
      return Promise.resolve(null);
    }
    this.store.set(key, { value, expireAt: Date.now() + ttlMs });
    return Promise.resolve('OK');
  }

  eval(_script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const [key, token] = args as [string, string];
    const existing = this.store.get(key);
    if (existing && existing.value === token) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
}

describe('RedisLock.withLock', () => {
  it('acquires, runs fn, returns its result, and releases', async () => {
    const redis = new FakeRedis();
    const setSpy = vi.spyOn(redis, 'set');
    const lock = new RedisLock(redis);

    const result = await lock.withLock('schedule:1', { ttlMs: 5000 }, async () => 'done');

    expect(result).toBe('done');
    expect(redis.store.has('schedule:1')).toBe(false); // released
    expect(setSpy).toHaveBeenCalledWith('schedule:1', expect.any(String), 'PX', 5000, 'NX');
  });

  it('releases the lock even when fn throws (and re-throws the error)', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLock(redis);

    await expect(
      lock.withLock('k', { ttlMs: 5000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(redis.store.has('k')).toBe(false);
    // Lock is free again afterwards.
    await expect(lock.withLock('k', {}, async () => 'ok')).resolves.toBe('ok');
  });

  it('throws LockAcquisitionError when the key is already held', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLock(redis);

    await lock.withLock('k', { ttlMs: 5000 }, async () => {
      await expect(
        lock.withLock('k', { waitMs: 30, retryDelayMs: 5 }, async () => 'inner'),
      ).rejects.toBeInstanceOf(LockAcquisitionError);
    });
  });

  it('serializes a waiter: it acquires once the holder releases', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLock(redis);
    const order: string[] = [];

    const holder = lock.withLock('k', { ttlMs: 5000 }, async () => {
      order.push('holder:start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('holder:end');
    });

    const waiter = lock.withLock('k', { waitMs: 500, retryDelayMs: 5 }, async () => {
      order.push('waiter:run');
    });

    await Promise.all([holder, waiter]);
    expect(order).toEqual(['holder:start', 'holder:end', 'waiter:run']);
  });

  it('release is token-scoped: it never deletes a lock another owner now holds', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLock(redis);

    await lock.withLock('k', { ttlMs: 5000, waitMs: 0 }, async () => {
      // Simulate our lock expiring and a different worker taking it.
      redis.store.set('k', { value: 'other-owner', expireAt: Date.now() + 5000 });
    });

    expect(redis.store.get('k')?.value).toBe('other-owner');
  });

  it('tries exactly once when waitMs is 0', async () => {
    const redis = new FakeRedis();
    redis.store.set('k', { value: 'someone', expireAt: Date.now() + 5000 });
    const setSpy = vi.spyOn(redis, 'set');
    const lock = new RedisLock(redis);

    await expect(lock.withLock('k', { waitMs: 0 }, async () => 'never')).rejects.toBeInstanceOf(
      LockAcquisitionError,
    );
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
