import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';

function make(dbOk: boolean, redisOk: boolean) {
  const pool = {
    query: vi.fn(() =>
      dbOk ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('db down')),
    ),
  };
  const redis = {
    ping: vi.fn(() =>
      redisOk ? Promise.resolve('PONG') : Promise.reject(new Error('redis down')),
    ),
  };
  return { service: new HealthService(pool as never, redis as never), pool, redis };
}

describe('HealthService', () => {
  it('reports ok when db and redis are both up', async () => {
    const { service } = make(true, true);
    const result = await service.check();
    expect(result.status).toBe('ok');
    expect(result.info).toEqual({ db: 'up', redis: 'up' });
    expect(typeof result.timestamp).toBe('string');
  });

  it('reports degraded when db is down', async () => {
    const { service } = make(false, true);
    const result = await service.check();
    expect(result.status).toBe('degraded');
    expect(result.info.db).toBe('down');
    expect(result.info.redis).toBe('up');
  });

  it('reports degraded when redis is down', async () => {
    const { service } = make(true, false);
    const result = await service.check();
    expect(result.status).toBe('degraded');
    expect(result.info.db).toBe('up');
    expect(result.info.redis).toBe('down');
  });

  it('reports degraded when both are down', async () => {
    const { service } = make(false, false);
    const result = await service.check();
    expect(result.status).toBe('degraded');
    expect(result.info).toEqual({ db: 'down', redis: 'down' });
  });
});
