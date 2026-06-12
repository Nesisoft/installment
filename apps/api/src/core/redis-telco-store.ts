import type Redis from 'ioredis';
import type { Telco, TelcoCounts, TelcoHealthStore } from '@installment/core';

/**
 * Redis-backed {@link TelcoHealthStore}. One sorted set per telco, scored by
 * outcome timestamp; the member encodes success/failure. Reads window with
 * ZRANGEBYSCORE and opportunistically prune everything older than `retentionMs`.
 */
export class RedisTelcoHealthStore implements TelcoHealthStore {
  private readonly retentionMs: number;

  constructor(
    private readonly redis: Redis,
    opts: { retentionMs?: number } = {},
  ) {
    // Keep an hour of history by default — well beyond any sane health window.
    this.retentionMs = opts.retentionMs ?? 60 * 60_000;
  }

  private key(telco: Telco): string {
    return `telco-health:${telco}`;
  }

  async record(telco: Telco, success: boolean, at: Date): Promise<void> {
    const ts = at.getTime();
    const member = `${ts}:${success ? 's' : 'f'}:${Math.random().toString(36).slice(2, 8)}`;
    const key = this.key(telco);
    await this.redis
      .multi()
      .zadd(key, ts, member)
      .zremrangebyscore(key, 0, ts - this.retentionMs) // prune old
      .pexpire(key, this.retentionMs)
      .exec();
  }

  async counts(telco: Telco, since: Date): Promise<TelcoCounts> {
    const members = await this.redis.zrangebyscore(this.key(telco), since.getTime(), '+inf');
    let success = 0;
    let failure = 0;
    for (const m of members) {
      // member shape: `${ts}:${'s'|'f'}:${rand}`
      if (m.split(':')[1] === 's') success += 1;
      else failure += 1;
    }
    return { success, failure };
  }
}
