import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@installment/db';
import type Redis from 'ioredis';
import { PG_POOL } from '../db/db.module';
import { REDIS } from '../redis/redis.module';

export type ComponentStatus = 'up' | 'down';

export interface HealthResult {
  status: 'ok' | 'degraded';
  info: {
    db: ComponentStatus;
    redis: ComponentStatus;
  };
  timestamp: string;
}

/**
 * How long a Redis answer is reused. A platform health check calls this every
 * few seconds (Render's does), and on a Redis billed per command (Upstash's
 * free tier is 500K a month) a PING every five seconds is over 500K a month on
 * its own. The database is still asked every time: Postgres is not billed per
 * query, and it is the check that catches a bad deploy.
 */
export const REDIS_HEALTH_TTL_MS = 60_000;

@Injectable()
export class HealthService {
  private redisAnswer: { at: number; status: ComponentStatus } | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'ping'>,
  ) {}

  async check(): Promise<HealthResult> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const status = db === 'up' && redis === 'up' ? 'ok' : 'degraded';
    return {
      status,
      info: { db, redis },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<ComponentStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(now = Date.now()): Promise<ComponentStatus> {
    // Only an `up` is reused: a Redis that was down is asked again next time,
    // so recovery shows at once and a failure is never hidden behind the cache.
    if (this.redisAnswer && now - this.redisAnswer.at < REDIS_HEALTH_TTL_MS) {
      return this.redisAnswer.status;
    }
    let status: ComponentStatus;
    try {
      status = (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      status = 'down';
    }
    this.redisAnswer = status === 'up' ? { at: now, status } : null;
    return status;
  }
}
