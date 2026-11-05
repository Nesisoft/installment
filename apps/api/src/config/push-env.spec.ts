import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';
import { createPushSender } from '../core/push-sender.factory';
import { ConsolePushSender, maskToken } from '../core/console-push-sender';
import { ExpoPushClient } from '@installment/push-client';
import type { Env } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
};

/** A production env that satisfies every other refusal, so only push is at issue. */
const PROD = {
  ...BASE,
  NODE_ENV: 'production',
  SMS_PROVIDER: 'arkesel',
  ARKESEL_API_KEY: 'k',
  STORAGE_DRIVER: 's3',
  STORAGE_BUCKET: 'b',
  STORAGE_ACCESS_KEY_ID: 'k',
  STORAGE_SECRET_ACCESS_KEY: 's',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

/** ConfigService's shape, narrowed to what the factory actually calls. */
function configOf(env: Env) {
  return { get: <K extends keyof Env>(key: K) => env[key] };
}

describe('push environment', () => {
  it('defaults to the console sender, which keeps boot friction-free', () => {
    const env = validateEnv(BASE);

    expect(env.PUSH_PROVIDER).toBe('console');
    expect(createPushSender(configOf(env) as never)).toBeInstanceOf(ConsolePushSender);
  });

  it('refuses to start production on the console sender', () => {
    // The same shape as the SMS refusal, and for the same reason: a provider
    // that delivers nothing does not fail visibly. It fails one merchant at a
    // time, at the moment an order they were never told about goes unconfirmed,
    // and `notifications` records every one of those as sent.
    expect(() => validateEnv({ ...PROD, PUSH_PROVIDER: 'console' })).toThrow(/PUSH_PROVIDER/);
    expect(() => validateEnv({ ...PROD, PUSH_PROVIDER: 'console' })).toThrow(/delivers nothing/);
  });

  it('accepts production on expo', () => {
    const env = validateEnv({ ...PROD, PUSH_PROVIDER: 'expo' });

    expect(env.PUSH_PROVIDER).toBe('expo');
    expect(createPushSender(configOf(env) as never)).toBeInstanceOf(ExpoPushClient);
  });

  it('needs no Expo access token, because a push token is itself the capability', () => {
    // Unlike the SMS providers, which are refused without credentials. Expo
    // only requires one when the project turns on enhanced push security, so
    // demanding it here would fail a boot over a variable most deployments
    // never set.
    expect(() => validateEnv({ ...PROD, PUSH_PROVIDER: 'expo' })).not.toThrow();
  });

  it('rejects a provider that is not in the catalogue', () => {
    expect(() => validateEnv({ ...BASE, PUSH_PROVIDER: 'firebase' })).toThrow();
  });
});

describe('maskToken', () => {
  it('leaves enough to correlate and not enough to send', () => {
    // An Expo push token is a bearer capability: anyone holding it can put a
    // notification on that handset, so a log full of them is a log full of
    // credentials.
    expect(maskToken('ExponentPushToken[abcdef123456]')).toBe('ExponentPushToken[ab********56]');
    expect(maskToken('ExpoPushToken[xy]')).toBe('ExpoPushToken[**]');
  });

  it('masks something that is not a token at all rather than echoing it', () => {
    expect(maskToken('not-a-token')).toBe('*'.repeat('not-a-token'.length));
  });
});
