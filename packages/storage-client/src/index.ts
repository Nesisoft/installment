import { LocalDiskDriver, type LocalDriverConfig } from './local';
import { S3Driver, type S3DriverConfig } from './s3';
import {
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedUpload,
  type StorageDriver,
} from './types';

export { presignS3Url, toAmzDate, uriEncode, type SigV4Params } from './sigv4';
export { S3Driver, type S3DriverConfig } from './s3';
export {
  LocalDiskDriver,
  resolveLocalPath,
  signLocalToken,
  verifyLocalToken,
  type LocalDriverConfig,
  type LocalToken,
} from './local';
export {
  StorageConfigurationError,
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedUpload,
  type StorageDriver,
  type StorageVisibility,
} from './types';

/** Storage is switched off. Reads still resolve; nothing new can be uploaded. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super('Object storage is not configured on this deployment');
    this.name = 'StorageNotConfiguredError';
  }
}

/**
 * The driver a deployment gets when `STORAGE_DRIVER=none`.
 *
 * Refusing loudly at the moment of upload beats a `StorageDriver | null` that
 * every call site has to remember to check — and beats booting without storage
 * silently, which is how you discover on launch day that nobody set the bucket.
 * Existing images still resolve, because `MediaService` reads `MEDIA_BASE_URL`
 * and does not go through a driver at all.
 */
export class NullStorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  readonly publicBaseUrl = '';

  presignUpload(_input: PresignUploadInput): PresignedUpload {
    throw new StorageNotConfiguredError();
  }

  presignDownload(_input: PresignDownloadInput): string {
    throw new StorageNotConfiguredError();
  }
}

export type StorageConfig =
  | { driver: 'none' }
  | ({ driver: 's3' } & S3DriverConfig)
  | ({ driver: 'local' } & LocalDriverConfig);

export function createStorageDriver(config: StorageConfig): StorageDriver {
  switch (config.driver) {
    case 's3':
      return new S3Driver(config);
    case 'local':
      return new LocalDiskDriver(config);
    case 'none':
      return new NullStorageDriver();
  }
}
