import type Redis from 'ioredis';
import type { OtpStore } from '@installment/core';

/** ioredis-backed {@link OtpStore} with millisecond TTLs. */
export class RedisOtpStore implements OtpStore {
  constructor(private readonly redis: Redis) {}

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
