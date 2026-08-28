import {
  NullStorageDriver,
  type PresignedUpload,
  type StorageDriver,
} from '@installment/storage-client';
import {
  UploadNotAllowedError,
  UPLOAD_PURPOSES,
  deriveUploadKey,
  requestUploadSchema,
  type UploadPurpose,
} from './upload-policy';

export interface UploadsConfig {
  maxUploadBytes: number;
  uploadTtlSeconds: number;
}

/**
 * Issues upload URLs, and time-boxed read URLs for the private ones.
 *
 * The whole surface is deliberately three lines of logic wrapped in checks: the
 * value is in what it refuses. Every route hands it the caller's own id, and it
 * hands back a URL that can write to exactly one key.
 */
export class UploadsService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly config: UploadsConfig,
  ) {}

  /**
   * @param allowed Purposes this surface may request. The merchant portal, the
   *   admin console and the customer app each pass their own list, so a stolen
   *   merchant token cannot ask for a KYC key and a customer cannot write into
   *   the catalogue.
   */
  request(
    rawInput: unknown,
    ownerId: string | undefined,
    allowed: UploadPurpose[],
  ): PresignedUpload {
    const input = requestUploadSchema.parse(rawInput);
    if (!allowed.includes(input.purpose)) {
      throw new UploadNotAllowedError(`${input.purpose} cannot be uploaded from here`);
    }

    const derived = deriveUploadKey(input, ownerId, this.config.maxUploadBytes);
    return this.driver.presignUpload({
      key: derived.key,
      contentType: derived.contentType,
      visibility: derived.visibility,
      expiresInSeconds: this.config.uploadTtlSeconds,
    });
  }

  /**
   * A short-lived read of a private object for a caller the route has already
   * authorised. Kept short on purpose: the URL is a bearer token for personal
   * data, and it will end up in a browser history and a proxy log.
   */
  readPrivate(key: string, expiresInSeconds = 120): { url: string; expires_at: string } {
    if (!key.startsWith('private/')) {
      // A public key needs no signature, and signing one would imply the object
      // is protected when anyone with the URL can already fetch it.
      throw new UploadNotAllowedError('Only private objects are read through a signed URL');
    }
    return {
      url: this.driver.presignDownload({ key, expiresInSeconds }),
      expires_at: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
    };
  }

  /** What a client may send, so an upload picker can filter before it tries. */
  limits(allowed: UploadPurpose[]): {
    max_bytes: number;
    ttl_seconds: number;
    purposes: { purpose: UploadPurpose; content_types: string[] }[];
  } {
    return {
      max_bytes: this.config.maxUploadBytes,
      ttl_seconds: this.config.uploadTtlSeconds,
      purposes: allowed.map((purpose) => ({
        purpose,
        content_types: Object.keys(UPLOAD_PURPOSES[purpose].types),
      })),
    };
  }

  get configured(): boolean {
    return !(this.driver instanceof NullStorageDriver);
  }
}
