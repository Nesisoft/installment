/**
 * The contract every storage backend implements.
 *
 * Deliberately small: this package moves bytes and nothing else. It knows
 * nothing about products, merchants or KYC — the caller derives the key and
 * decides who may ask for it. See `apps/api/src/media/upload-policy.ts` for
 * that half.
 */

/**
 * Who may read an object once it exists.
 *
 * The split is load-bearing, not decorative. Product images and store logos are
 * fetched by anonymous shoppers, so they live under a public prefix served
 * straight off a CDN. A Ghana Card photograph is personal data under the Data
 * Protection Act, 2012 (Act 843) — putting it in the same bucket would make it
 * world-readable to anyone holding the key, and keys leak through logs, screen
 * shares and referrer headers. Private objects are therefore never resolvable
 * by `MediaService`; the only way to read one is a short-lived presigned GET
 * issued to a caller the API has already authorised.
 */
export type StorageVisibility = 'public' | 'private';

export interface PresignUploadInput {
  /** Full object key, already derived by the caller. Never client-supplied. */
  key: string;
  /**
   * Pinned into the signature, so a URL issued for a JPEG cannot be used to
   * upload an HTML page and have the bucket serve it from our own origin.
   */
  contentType: string;
  visibility: StorageVisibility;
  expiresInSeconds: number;
  /** Overridable so a test can assert an exact URL. Defaults to now. */
  now?: Date;
}

/**
 * Everything a client needs to perform the upload itself, in a shape that is
 * identical across drivers — so the phone and the merchant portal do a plain
 * `fetch(url, { method, headers, body: file })` and never learn which backend
 * is behind it.
 */
export interface PresignedUpload {
  key: string;
  url: string;
  method: 'PUT';
  /** Must be sent verbatim: they are part of what was signed. */
  headers: Record<string, string>;
  /** ISO-8601. After this the URL is refused by the backend, not by us. */
  expires_at: string;
}

export interface PresignDownloadInput {
  key: string;
  expiresInSeconds: number;
  now?: Date;
}

export interface StorageDriver {
  readonly name: 's3' | 'local';

  /**
   * Public prefix that objects stored with `visibility: 'public'` are served
   * from, or `''` when the driver cannot serve them (which makes every image
   * URL resolve to null and the apps fall back to their placeholder tile).
   */
  readonly publicBaseUrl: string;

  /**
   * Signing is pure computation for every driver we have — no network, no
   * state — so this is synchronous. An async signature would imply a round
   * trip that does not happen and would make every caller await for nothing.
   */
  presignUpload(input: PresignUploadInput): PresignedUpload;

  /** A time-boxed read of a private object, for a caller already authorised. */
  presignDownload(input: PresignDownloadInput): string;
}

/** Raised for configuration that cannot produce a working driver. */
export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}
