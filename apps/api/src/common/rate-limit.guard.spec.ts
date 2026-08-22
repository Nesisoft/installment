import { describe, expect, it } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard, type RateLimitDefaults } from './rate-limit.guard';
import { RATE_LIMIT_KEY, RATE_LIMIT_SKIP_KEY, type RateLimitOptions } from './rate-limit.decorator';

const DEFAULTS: RateLimitDefaults = { enabled: true, limit: 3, windowSeconds: 60 };

/** Minimal ioredis stand-in: counts INCRs per key, like a fixed window would. */
function fakeRedis(overrides: { failing?: boolean; ttl?: number } = {}) {
  const counts = new Map<string, number>();
  return {
    counts,
    multi() {
      const chain = {
        key: '',
        incr(key: string) {
          chain.key = key;
          return chain;
        },
        expire() {
          return chain;
        },
        async exec() {
          if (overrides.failing) throw new Error('redis down');
          const next = (counts.get(chain.key) ?? 0) + 1;
          counts.set(chain.key, next);
          return [
            [null, next],
            [null, 1],
          ];
        },
      };
      return chain;
    },
    async ttl() {
      return overrides.ttl ?? 42;
    },
  };
}

function contextFor(
  opts: { route?: RateLimitOptions; skip?: boolean; ip?: string; userId?: string } = {},
) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  const req = {
    method: 'POST',
    ip: opts.ip ?? '10.0.0.1',
    socket: { remoteAddress: opts.ip ?? '10.0.0.1' },
    ...(opts.userId ? { user: { id: opts.userId } } : {}),
  };
  const ctx = {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === RATE_LIMIT_SKIP_KEY) return opts.skip;
      if (key === RATE_LIMIT_KEY) return opts.route;
      return undefined;
    },
  } as unknown as Reflector;

  return { ctx, reflector, headers };
}

describe('RateLimitGuard', () => {
  it('allows requests up to the limit and then rejects with 429', async () => {
    const redis = fakeRedis();
    const { ctx, reflector, headers } = contextFor();
    const guard = new RateLimitGuard(redis as never, reflector, DEFAULTS);

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(headers['RateLimit-Remaining']).toBe('0');

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
    expect(headers['Retry-After']).toBe('42');
  });

  it('applies a per-route override instead of the default', async () => {
    const redis = fakeRedis();
    const { ctx, reflector } = contextFor({ route: { limit: 1, windowSeconds: 300 } });
    const guard = new RateLimitGuard(redis as never, reflector, DEFAULTS);

    expect(await guard.canActivate(ctx)).toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  it('never limits a route marked @SkipRateLimit (webhooks must not be dropped)', async () => {
    const redis = fakeRedis();
    const { ctx, reflector } = contextFor({ skip: true });
    const guard = new RateLimitGuard(redis as never, reflector, DEFAULTS);

    for (let i = 0; i < 10; i += 1) {
      expect(await guard.canActivate(ctx)).toBe(true);
    }
    expect(redis.counts.size).toBe(0);
  });

  it('buckets separate clients independently', async () => {
    const redis = fakeRedis();
    const guard = new RateLimitGuard(redis as never, contextFor().reflector, DEFAULTS);
    const a = contextFor({ ip: '10.0.0.1' });
    const b = contextFor({ ip: '10.0.0.2' });

    for (let i = 0; i < 3; i += 1) await guard.canActivate(a.ctx);
    await expect(guard.canActivate(a.ctx)).rejects.toBeInstanceOf(HttpException);

    // The second client still has its full allowance.
    expect(await guard.canActivate(b.ctx)).toBe(true);
  });

  it('buckets an authenticated caller by user, not by shared IP', async () => {
    const redis = fakeRedis();
    const guard = new RateLimitGuard(redis as never, contextFor().reflector, DEFAULTS);
    // Same NAT address, two customers — they must not consume each other's budget.
    const one = contextFor({ ip: '10.0.0.9', userId: 'user-1' });
    const two = contextFor({ ip: '10.0.0.9', userId: 'user-2' });

    for (let i = 0; i < 3; i += 1) await guard.canActivate(one.ctx);
    await expect(guard.canActivate(one.ctx)).rejects.toBeInstanceOf(HttpException);
    expect(await guard.canActivate(two.ctx)).toBe(true);
  });

  it('fails open when Redis is unreachable rather than taking the API down', async () => {
    const redis = fakeRedis({ failing: true });
    const { ctx, reflector } = contextFor();
    const guard = new RateLimitGuard(redis as never, reflector, DEFAULTS);

    for (let i = 0; i < 10; i += 1) {
      expect(await guard.canActivate(ctx)).toBe(true);
    }
  });

  it('does nothing when disabled', async () => {
    const redis = fakeRedis();
    const { ctx, reflector } = contextFor();
    const guard = new RateLimitGuard(redis as never, reflector, { ...DEFAULTS, enabled: false });

    for (let i = 0; i < 10; i += 1) {
      expect(await guard.canActivate(ctx)).toBe(true);
    }
    expect(redis.counts.size).toBe(0);
  });

  it('ignores non-http contexts (cron and queue work is not a request)', async () => {
    const redis = fakeRedis();
    const { reflector } = contextFor();
    const guard = new RateLimitGuard(redis as never, reflector, DEFAULTS);
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;

    expect(await guard.canActivate(rpc)).toBe(true);
    expect(redis.counts.size).toBe(0);
  });
});
