import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';
import { createDriverFromEnv, resolveMediaBaseUrl } from '../core/storage.factory';
import { LocalDiskDriver, NullStorageDriver, S3Driver } from '@installment/storage-client';
import type { Env } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
};

const PROD = { ...BASE, NODE_ENV: 'production', SMS_PROVIDER: 'arkesel', ARKESEL_API_KEY: 'k' };

/** ConfigService's shape, narrowed to what the factory actually calls. */
function configOf(env: Env) {
  return { get: <K extends keyof Env>(key: K) => env[key] };
}

describe('storage environment', () => {
  it('defaults to no storage, which keeps boot friction-free', () => {
    const env = validateEnv(BASE);

    expect(env.STORAGE_DRIVER).toBe('none');
    expect(createDriverFromEnv(configOf(env))).toBeInstanceOf(NullStorageDriver);
  });

  it.each(['STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'])(
    'refuses STORAGE_DRIVER=s3 without %s',
    (missing) => {
      const full = {
        ...BASE,
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET: 'b',
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
      };
      // A driver selected without what it needs fails on the first upload, and
      // the first upload is a merchant listing a product, not a developer at a
      // terminal.
      expect(() => validateEnv({ ...full, [missing]: '' })).toThrow(/requires/);
    },
  );

  it('refuses the local driver in production', () => {
    // It writes to a container filesystem that a redeploy discards.
    expect(() => validateEnv({ ...PROD, STORAGE_DRIVER: 'local' })).toThrow(/redeploy discards/);
  });

  it('allows s3 in production', () => {
    expect(() =>
      validateEnv({
        ...PROD,
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET: 'ejua-media',
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
      }),
    ).not.toThrow();
  });
});

describe('createDriverFromEnv', () => {
  it('builds the local driver from the API origin', () => {
    const driver = createDriverFromEnv(
      configOf(
        validateEnv({ ...BASE, STORAGE_DRIVER: 'local', PUBLIC_API_URL: 'http://host:3000' }),
      ),
    );

    expect(driver).toBeInstanceOf(LocalDiskDriver);
    expect(driver.publicBaseUrl).toBe('http://host:3000/media');
  });

  it('builds the s3 driver, passing an empty endpoint through as AWS', () => {
    const driver = createDriverFromEnv(
      configOf(
        validateEnv({
          ...BASE,
          STORAGE_DRIVER: 's3',
          STORAGE_BUCKET: 'ejua-media',
          STORAGE_ACCESS_KEY_ID: 'k',
          STORAGE_SECRET_ACCESS_KEY: 's',
          STORAGE_PUBLIC_URL: 'https://cdn.ejua.gh',
        }),
      ),
    );

    expect(driver).toBeInstanceOf(S3Driver);
    expect(driver.publicBaseUrl).toBe('https://cdn.ejua.gh');
  });
});

describe('resolveMediaBaseUrl', () => {
  const driver = new NullStorageDriver();

  it('lets MEDIA_BASE_URL win, because a CDN is a different host from the bucket', () => {
    const s3 = new S3Driver({
      bucket: 'b',
      region: 'eu-west-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicBaseUrl: 'https://bucket.example',
    });

    expect(resolveMediaBaseUrl('https://cdn.ejua.gh', s3)).toBe('https://cdn.ejua.gh');
  });

  it('falls back to the driver so storage is one variable, not two that must agree', () => {
    const local = new LocalDiskDriver({
      baseUrl: 'http://localhost:3000',
      directory: '/tmp/m',
      secret: 'x',
    });

    expect(resolveMediaBaseUrl('', local)).toBe('http://localhost:3000/media');
  });

  it('is empty when neither is set, which draws the placeholder tile', () => {
    expect(resolveMediaBaseUrl('', driver)).toBe('');
  });
});
