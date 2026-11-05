import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
};

/** Every other production refusal satisfied, so only the JWT secrets are at issue. */
const PROD = {
  ...BASE,
  NODE_ENV: 'production',
  SMS_PROVIDER: 'arkesel',
  ARKESEL_API_KEY: 'k',
  PUSH_PROVIDER: 'expo',
};

describe('JWT secrets', () => {
  it('refuses production on the published development secrets, set or defaulted', () => {
    // Unset falls back to exactly the values .env.example publishes, so both
    // the forgotten variable and the copied file have to be refused.
    expect(() => validateEnv(PROD)).toThrow(/JWT_ACCESS_SECRET is the published development value/);
    expect(() =>
      validateEnv({
        ...PROD,
        JWT_ACCESS_SECRET: 'dev-access-secret-change-me!!',
        JWT_REFRESH_SECRET: 'r'.repeat(32),
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
    expect(() =>
      validateEnv({
        ...PROD,
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me!!',
      }),
    ).toThrow(/JWT_REFRESH_SECRET is the published development value/);
  });

  it('accepts production with secrets of its own', () => {
    const env = validateEnv({
      ...PROD,
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    });
    expect(env.JWT_ACCESS_SECRET).toBe('a'.repeat(32));
  });

  it('keeps the development defaults working everywhere else', () => {
    expect(validateEnv(BASE).JWT_ACCESS_SECRET).toBe('dev-access-secret-change-me!!');
  });
});

describe('hosted Postgres and Redis settings', () => {
  it('defaults suit a local stack', () => {
    const env = validateEnv(BASE);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.QUEUE_DRAIN_DELAY_SECONDS).toBe(5);
    expect(env.QUEUE_STALLED_INTERVAL_SECONDS).toBe(30);
  });

  it('reads the values a Supabase and Upstash deployment sets', () => {
    const env = validateEnv({
      ...BASE,
      DATABASE_POOL_MAX: '5',
      QUEUE_DRAIN_DELAY_SECONDS: '300',
      QUEUE_STALLED_INTERVAL_SECONDS: '300',
    });
    expect(env.DATABASE_POOL_MAX).toBe(5);
    expect(env.QUEUE_DRAIN_DELAY_SECONDS).toBe(300);
    expect(env.QUEUE_STALLED_INTERVAL_SECONDS).toBe(300);
  });

  it('refuses a pool or interval of zero', () => {
    expect(() => validateEnv({ ...BASE, DATABASE_POOL_MAX: '0' })).toThrow(/DATABASE_POOL_MAX/);
    // BullMQ itself throws on a drainDelay of 0, but only when the worker starts.
    expect(() => validateEnv({ ...BASE, QUEUE_DRAIN_DELAY_SECONDS: '0' })).toThrow(
      /QUEUE_DRAIN_DELAY_SECONDS/,
    );
  });
});
