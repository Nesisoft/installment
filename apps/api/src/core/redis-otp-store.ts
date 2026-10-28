import type Redis from 'ioredis';
import type { OtpStore } from '@installment/core';

/**
 * Creates the counter with its expiry in the same step as the first increment,
 * so a counter can never outlive the code it counts.
 */
const INCR_WITH_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** ioredis-backed {@link OtpStore} with millisecond TTLs. */
export class RedisOtpStore implements OtpStore {
  constructor(private readonly redis: Redis) {}

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /** DEL is atomic: of two concurrent deletes of one key, one gets 1. */
  del(key: string): Promise<number> {
    return this.redis.del(key);
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    const n = await this.redis.eval(INCR_WITH_TTL, 1, key, String(Math.max(1, Math.ceil(ttlMs))));
    return Number(n);
  }
}
