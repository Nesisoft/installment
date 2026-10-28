import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { OtpService } from '@installment/core';
import { RedisOtpStore } from './redis-otp-store';

const REDIS_URL = process.env.REDIS_URL;

/**
 * The one-time code's guarantees, against real Redis: a code is used once, a
 * used code stays used, and the attempt cap holds however many guesses arrive
 * at once. Each depends on DEL and the INCR script being atomic, which a fake
 * store can only assume.
 */
describe.skipIf(!REDIS_URL)('RedisOtpStore + OtpService (real Redis)', () => {
  const redis = new Redis(REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const prefix = `otp-test:${randomUUID()}:`;
  const store = new RedisOtpStore(redis);

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  const fresh = () => `+233${Math.floor(200_000_000 + Math.random() * 99_999_999)}`;

  it('holds the attempt cap against fifty guesses sent at once', async () => {
    const svc = new OtpService(store, { keyPrefix: prefix, maxAttempts: 5 });
    const target = fresh();
    const { code } = await svc.start(target);
    const wrong = code === '000000' ? '000001' : '000000';

    const results = await Promise.all(Array.from({ length: 50 }, () => svc.verify(target, wrong)));

    expect(results.some(Boolean)).toBe(false);
    // Burned: the right code no longer works either.
    expect(await svc.verify(target, code)).toBe(false);
  });

  it('lets exactly one of ten simultaneous correct verifies use the code', async () => {
    const svc = new OtpService(store, { keyPrefix: prefix });
    const target = fresh();
    const { code } = await svc.start(target);
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.verify(target, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('gives the attempt counter the code’s own lifetime', async () => {
    const svc = new OtpService(store, { keyPrefix: prefix, ttlMs: 60_000 });
    const target = fresh();
    await svc.start(target);
    await svc.verify(target, 'xxxxxx');
    const ttl = await redis.pttl(`${prefix}attempts:${target}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
