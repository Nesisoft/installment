import { createStorageDriver, type StorageDriver } from '@installment/storage-client';
import type { Env } from '../config/env.validation';

/**
 * Turns the STORAGE_* environment into a driver.
 *
 * Kept out of `core.module.ts` because the config-to-driver mapping is the part
 * a deployment gets wrong, and it reads better as one function than as a
 * `useFactory` buried among sixty providers.
 */
export function createDriverFromEnv(env: {
  get<K extends keyof Env>(key: K, options: { infer: true }): Env[K];
}): StorageDriver {
  const driver = env.get('STORAGE_DRIVER', { infer: true });

  if (driver === 'local') {
    return createStorageDriver({
      driver: 'local',
      baseUrl: env.get('PUBLIC_API_URL', { infer: true }),
      directory: env.get('STORAGE_LOCAL_DIR', { infer: true }),
      secret: env.get('STORAGE_UPLOAD_SECRET', { infer: true }),
    });
  }

  if (driver === 's3') {
    const endpoint = env.get('STORAGE_ENDPOINT', { infer: true });
    return createStorageDriver({
      driver: 's3',
      bucket: env.get('STORAGE_BUCKET', { infer: true }),
      region: env.get('STORAGE_REGION', { infer: true }),
      accessKeyId: env.get('STORAGE_ACCESS_KEY_ID', { infer: true }),
      secretAccessKey: env.get('STORAGE_SECRET_ACCESS_KEY', { infer: true }),
      endpoint: endpoint || undefined,
      forcePathStyle: env.get('STORAGE_FORCE_PATH_STYLE', { infer: true }),
      publicBaseUrl: env.get('STORAGE_PUBLIC_URL', { infer: true }),
    });
  }

  return createStorageDriver({ driver: 'none' });
}

/**
 * Where image URLs are resolved from.
 *
 * MEDIA_BASE_URL wins when it is set — a CDN in front of the bucket is a
 * different hostname from the bucket, and only the operator knows it. Otherwise
 * the driver's own public prefix stands in, so configuring storage is one
 * variable rather than two that have to agree. Both empty means every image URL
 * resolves to null and the apps draw their placeholder tile, which is the
 * quiet degradation `MediaService` was written for.
 */
export function resolveMediaBaseUrl(explicit: string, driver: StorageDriver): string {
  return explicit || driver.publicBaseUrl;
}
