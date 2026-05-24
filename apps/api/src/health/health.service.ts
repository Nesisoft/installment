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

@Injectable()
export class HealthService {
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

  private async checkRedis(): Promise<ComponentStatus> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
