import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Request, Response } from 'express';
import { REDIS } from '../redis/redis.module';
import { RATE_LIMIT_KEY, RATE_LIMIT_SKIP_KEY, type RateLimitOptions } from './rate-limit.decorator';

export interface RateLimitDefaults {
  enabled: boolean;
  limit: number;
  windowSeconds: number;
}

/**
 * Redis-backed request limiter (DEVELOPMENT-PLAN.md §Phase 10).
 *
 * Counts requests per client per window with a fixed-window counter: INCR, and
 * set the TTL on first use. A fixed window lets a client spend two windows'
 * worth of budget across a boundary; that burst is acceptable here and the
 * alternative (a sorted-set sliding window) costs memory per request on every
 * public endpoint. What matters is the ceiling on sustained abuse.
 *
 * Identity is the client IP, so behind a proxy the app MUST trust the forwarded
 * header (see TRUST_PROXY in main.ts) — otherwise every request appears to come
 * from the load balancer and the whole estate shares one bucket, which locks
 * everyone out at once rather than the abuser.
 *
 * Fails OPEN. If Redis is unreachable the request is allowed and the failure is
 * logged: an unavailable limiter must not take payments down with it. That is a
 * deliberate trade — during a Redis outage the ceilings are gone.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  /**
   * Tokens injected explicitly: the test build (esbuild) ignores
   * `emitDecoratorMetadata`, so type-based DI resolves to undefined under
   * vitest. Same reasoning as IdempotencyInterceptor.
   */
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject('RATE_LIMIT_DEFAULTS') private readonly defaults: RateLimitDefaults,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (!this.defaults.enabled) return true;

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(RATE_LIMIT_SKIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const override = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const limit = override?.limit ?? this.defaults.limit;
    const windowSeconds = override?.windowSeconds ?? this.defaults.windowSeconds;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const bucket =
      override?.bucket ?? `${req.method}:${context.getClass().name}.${context.getHandler().name}`;
    const key = `ratelimit:${bucket}:${clientId(req)}`;

    let count: number;
    try {
      // INCR then set the TTL with NX, so a window that lost its EXPIRE (a crash
      // between the two commands) still gets one rather than leaking forever.
      const results = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch (err) {
      this.logger.warn(
        `limiter unavailable, allowing request: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }

    const remaining = Math.max(0, limit - count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));

    if (count > limit) {
      const ttl = await this.ttl(key, windowSeconds);
      res.setHeader('Retry-After', String(ttl));
      throw new HttpException(
        {
          error: 'RateLimited',
          message: `Too many requests. Try again in ${ttl} second${ttl === 1 ? '' : 's'}.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private async ttl(key: string, fallback: number): Promise<number> {
    try {
      const ttl = await this.redis.ttl(key);
      return ttl > 0 ? ttl : fallback;
    } catch {
      return fallback;
    }
  }
}

/** The client a limit applies to: the authenticated user if known, else the IP. */
function clientId(req: Request & { user?: { id?: string } }): string {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
}
