import { presignS3Url } from './sigv4';
import {
  StorageConfigurationError,
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedUpload,
  type StorageDriver,
  type StorageVisibility,
} from './types';

/**
 * Where visibility actually lives: in the key.
 *
 * One bucket, private by default, with anonymous GET permitted on `public/*`
 * by a bucket policy (or a CDN whose origin path is `/public`). Keeping the
 * marker in the key means you can tell from a database row alone whether an
 * object is world-readable — an audit that would otherwise mean reconciling
 * every key against bucket policy. It also means the driver, not the caller,
 * decides: a policy layer that forgets to mark a KYC upload private still gets
 * a `private/` key, because the driver never trusts the prefix it was handed.
 */
const PREFIX: Record<StorageVisibility, string> = {
  public: 'public/',
  private: 'private/',
};

export interface S3DriverConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Base endpoint for non-AWS providers — `https://<account>.r2.cloudflarestorage.com`,
   * `https://fra1.digitaloceanspaces.com`, `http://localhost:9000` for MinIO.
   * Omitted means AWS S3, addressed virtual-host style.
   */
  endpoint?: string;
  /**
   * Put the bucket in the path rather than the hostname. R2 and MinIO require
   * it; DigitalOcean Spaces does not. Ignored without an endpoint, because AWS
   * path-style addressing is deprecated for new buckets.
   */
  forcePathStyle?: boolean;
  /** Public prefix `public/` objects are served from, e.g. a CDN hostname. */
  publicBaseUrl?: string;
}

/**
 * An S3-compatible driver, which in practice means every provider a Ghanaian
 * deployment would pick: S3 itself, Cloudflare R2 (no egress fees), DigitalOcean
 * Spaces, or MinIO on a box. They all verify the same SigV4 signature, so the
 * choice stays a config change rather than a code change.
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3' as const;
  readonly publicBaseUrl: string;

  private readonly host: string;
  private readonly pathPrefix: string;

  constructor(private readonly config: S3DriverConfig) {
    if (!config.bucket) throw new StorageConfigurationError('storage: bucket is required');
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new StorageConfigurationError('storage: access key id and secret are required');
    }

    const { host, pathPrefix } = resolveAddressing(config);
    this.host = host;
    this.pathPrefix = pathPrefix;
    this.publicBaseUrl = (config.publicBaseUrl ?? '').replace(/\/+$/, '');
  }

  presignUpload(input: PresignUploadInput): PresignedUpload {
    const key = this.resolveKey(input.key, input.visibility);
    const now = input.now ?? new Date();

    const url = presignS3Url({
      method: 'PUT',
      host: this.host,
      path: `${this.pathPrefix}/${key}`,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      expiresInSeconds: input.expiresInSeconds,
      // Pinning the type is what stops a URL handed out for a photograph being
      // used to upload `.html` that the bucket would then serve from our own
      // origin. The client must send exactly this Content-Type or the
      // signature does not verify.
      headers: { 'content-type': input.contentType },
      now,
    });

    return {
      key,
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expires_at: new Date(now.getTime() + input.expiresInSeconds * 1_000).toISOString(),
    };
  }

  presignDownload(input: PresignDownloadInput): string {
    return presignS3Url({
      method: 'GET',
      host: this.host,
      path: `${this.pathPrefix}/${stripLeadingSlash(input.key)}`,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      expiresInSeconds: input.expiresInSeconds,
      now: input.now ?? new Date(),
    });
  }

  /**
   * Forces the visibility prefix on, stripping any the caller already applied,
   * so `products/x.jpg` and `public/products/x.jpg` both land in one place and
   * a `private` upload can never be talked into a public key.
   */
  private resolveKey(rawKey: string, visibility: StorageVisibility): string {
    const bare = stripLeadingSlash(rawKey).replace(/^(public|private)\//, '');
    if (!bare) throw new StorageConfigurationError('storage: key is empty');
    return `${PREFIX[visibility]}${bare}`;
  }
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

/**
 * Splits a provider endpoint into the host to sign against and the path prefix
 * the bucket occupies — the one part of S3 compatibility that genuinely differs
 * between providers.
 */
function resolveAddressing(config: S3DriverConfig): { host: string; pathPrefix: string } {
  if (!config.endpoint) {
    // AWS, virtual-host style. Path-style addressing on AWS is deprecated for
    // buckets created after 2020, so we do not offer it.
    return { host: `${config.bucket}.s3.${config.region}.amazonaws.com`, pathPrefix: '' };
  }

  let host: string;
  try {
    host = new URL(config.endpoint).host;
  } catch {
    throw new StorageConfigurationError(`storage: endpoint "${config.endpoint}" is not a URL`);
  }

  return config.forcePathStyle
    ? { host, pathPrefix: `/${config.bucket}` }
    : { host: `${config.bucket}.${host}`, pathPrefix: '' };
}
