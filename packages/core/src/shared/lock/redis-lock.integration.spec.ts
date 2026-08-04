import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { LockAcquisitionError, RedisLock } from './redis-lock';

const RUN_REDIS = Boolean(process.env.REDIS_URL);

/**
 * S15 — the lock, against an actual Redis.
 *
 * `RedisLock` guards every critical section in the engine: a schedule's state
 * transition, the charge that must not fire twice, the reserve release. Until
 * this spec, it had never run against a real server. Every integration spec
 * that constructs one passes `ALWAYS_OPEN` — a stub whose `set` returns 'OK'
 * unconditionally and whose `eval` returns 1 — so the Lua release script had
 * literally never executed, and `SET ... PX ... NX` had never been asked to
 * refuse anything.
 *
 * A concurrency fix could therefore pass CI without the lock being exercised at
 * all. These cases run the real thing: the NX contention that makes the lock a
 * lock, the ownership check in the release script, and the TTL that is the only
 * thing standing between a crashed worker and a permanently stuck schedule.
 */
describe.skipIf(!RUN_REDIS)('RedisLock (integration)', () => {
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const lock = new RedisLock(redis);
  const key = () => `test:lock:${randomUUID()}`;

  afterAll(async () => {
    await redis.quit();
  });

  it('serialises two holders of the same key', async () => {
    const k = key();
    const order: string[] = [];
    const hold = async (name: string) =>
      lock.withLock(k, { ttlMs: 5_000, waitMs: 3_000, retryDelayMs: 10 }, async () => {
        order.push(`${name}:enter`);
        await new Promise((r) => setTimeout(r, 60));
        order.push(`${name}:exit`);
      });

    await Promise.all([hold('a'), hold('b')]);

    // Whoever went first finished before the other started — no interleaving.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`${order[0]!.split(':')[0]}:exit`);
    expect(order[3]).toBe(`${order[2]!.split(':')[0]}:exit`);
  });

  it('does not block two different keys', async () => {
    const [a, b] = [key(), key()];
    let concurrent = 0;
    let peak = 0;
    const hold = (k: string) =>
      lock.withLock(k, { ttlMs: 5_000, waitMs: 1_000 }, async () => {
        peak = Math.max(peak, ++concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
      });

    await Promise.all([hold(a), hold(b)]);
    expect(peak).toBe(2);
  });

  it('gives up rather than waiting forever when the key is held', async () => {
    const k = key();
    // `waitMs: 0` is what PaymentService uses: a second charge on the same
    // schedule must fail fast, not queue up behind the first.
    await lock.withLock(k, { ttlMs: 2_000, waitMs: 500 }, async () => {
      await expect(lock.withLock(k, { waitMs: 0 }, async () => 'never')).rejects.toBeInstanceOf(
        LockAcquisitionError,
      );
    });
  });

  it('releases the key once the critical section ends, even on a throw', async () => {
    const k = key();
    await expect(
      lock.withLock(k, { ttlMs: 5_000, waitMs: 500 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Released, not left to expire: the next holder gets it immediately.
    expect(await redis.get(k)).toBeNull();
    await expect(lock.withLock(k, { waitMs: 0 }, async () => 'free')).resolves.toBe('free');
  });

  it('expires on its own if the holder dies without releasing', async () => {
    const k = key();
    // Simulate a crashed worker: take the key directly and never release it.
    expect(await redis.set(k, 'dead-worker', 'PX', 150, 'NX')).toBe('OK');
    await expect(lock.withLock(k, { waitMs: 0 }, async () => 'now')).rejects.toBeInstanceOf(
      LockAcquisitionError,
    );

    // The TTL is the only recovery path here, and it is what stops a crash
    // wedging a schedule permanently.
    await expect(
      lock.withLock(k, { waitMs: 1_000, retryDelayMs: 25 }, async () => 'recovered'),
    ).resolves.toBe('recovered');
  });

  it('refuses to release a key it no longer owns', async () => {
    const k = key();
    await lock.withLock(k, { ttlMs: 5_000, waitMs: 500 }, async () => {
      // The lock expired mid-section and someone else took it. The release
      // script compares tokens before deleting; without that check this holder
      // would delete the *new* owner's lock on the way out, and two workers
      // would end up inside the same critical section.
      await redis.set(k, 'someone-else');
    });

    expect(await redis.get(k)).toBe('someone-else');
  });
});
