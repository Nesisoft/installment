import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit';
export const RATE_LIMIT_SKIP_KEY = 'rateLimitSkip';

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Bucket name. Routes sharing a name share a budget — use it to make a whole
   * family of endpoints (e.g. every OTP route) cost from one pot, so an attacker
   * cannot multiply their allowance by spreading across sibling routes.
   * Defaults to the route itself.
   */
  bucket?: string;
}

/**
 * Tightens the rate limit for a route beyond the global default.
 *
 * Reach for this on anything where a request costs real money or is worth
 * brute-forcing: sending an SMS, checking a password, guessing an OTP.
 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Exempts a route from rate limiting entirely.
 *
 * Reserved for traffic we must never drop: provider webhooks (Paystack retries
 * a rejected delivery, and a throttled webhook is a payment notification lost)
 * and health checks (a throttled probe reads as an outage).
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_SKIP_KEY, true);
