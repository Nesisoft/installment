import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, query-string form, for presigned S3 URLs.
 *
 * Hand-rolled rather than pulled from `@aws-sdk/*` for the same reason
 * `paystack-client` speaks HTTP directly: this workspace keeps its external
 * service wrappers dependency-light, and the AWS SDK is a large tree to carry
 * for one signature. It is also what makes the driver provider-agnostic —
 * Cloudflare R2, DigitalOcean Spaces, MinIO and S3 itself all verify the same
 * signature, so choosing a provider stays a config change.
 *
 * Reference: AWS "Signature Version 4 signing process", query-parameter variant.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Presigned PUTs are signed without hashing the body, which we never see. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Params {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Host only, no scheme — `bucket.s3.eu-west-1.amazonaws.com` or `xyz.r2.cloudflarestorage.com`. */
  host: string;
  /** Absolute path, already including the bucket when the endpoint is path-style. */
  path: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials also need the session token folded into the query. */
  sessionToken?: string;
  expiresInSeconds: number;
  /**
   * Headers to sign beyond `host`. Signing a header PINS it: the client must
   * send exactly this value or the signature will not verify, which is what
   * stops a URL issued for a small JPEG being used to upload something else.
   */
  headers?: Record<string, string>;
  now?: Date;
}

/** Builds a presigned URL. No network, no state — deterministic given `now`. */
export function presignS3Url(params: SigV4Params): string {
  const {
    method,
    host,
    path,
    region,
    service = 's3',
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresInSeconds,
    headers = {},
    now = new Date(),
  } = params;

  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  // `host` is always signed; anything else the caller pins joins it. Header
  // names are lower-cased and ordered, which the canonical form requires.
  const signedHeaderMap: Record<string, string> = { host };
  for (const [name, value] of Object.entries(headers)) {
    signedHeaderMap[name.toLowerCase()] = value.trim();
  }
  const signedHeaderNames = Object.keys(signedHeaderMap).sort();
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${signedHeaderMap[n]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
  };

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join('&');

  const canonicalRequest = [
    method,
    encodePath(path),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const key = signingKey(secretAccessKey, dateStamp, region, service);
  const signature = hmac(key, stringToSign).toString('hex');

  return `https://${host}${encodePath(path)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** `2026-08-28T17:00:00.000Z` → `20260828T170000Z`, the only form AWS accepts. */
export function toAmzDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone and AWS does
 * not, so an object key containing any of them would sign one way and be
 * requested another.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Path segments are encoded individually — the separating slashes stay literal. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}
