import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  StorageConfigurationError,
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedUpload,
  type StorageDriver,
} from './types';

/**
 * Filesystem storage for local development, behind the same presigned-URL shape
 * as S3.
 *
 * The point is that the *client* flow is byte-identical: the app asks the API
 * for an upload URL and PUTs the file at it, exactly as it will in production.
 * A "just multipart-POST it to the API in dev" shortcut would leave the real
 * path — presigning, pinned content types, expiry, direct-to-bucket transfer —
 * unexercised until the first deploy, which is precisely when you want it to
 * have been exercised already.
 *
 * The signature is an HMAC over the same facts SigV4 pins: method, key, content
 * type and expiry. It is not AWS-compatible and does not need to be; it needs
 * to be unforgeable, and a shared secret held only by the API is enough for
 * that, because the API is both signer and verifier here.
 *
 * Not for production. It writes to a container filesystem that a redeploy
 * discards, and it puts image bytes through the API process.
 */

export interface LocalDriverConfig {
  /** Origin the API is reachable at, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Directory objects are written under. Created on first write by the API. */
  directory: string;
  /** Secret the upload tokens are signed with. */
  secret: string;
}

/** The facts a token commits to. Changing any of them invalidates it. */
export interface LocalToken {
  method: 'PUT' | 'GET';
  key: string;
  contentType: string;
  /** Unix seconds. */
  expires: number;
}

export class LocalDiskDriver implements StorageDriver {
  readonly name = 'local' as const;
  readonly publicBaseUrl: string;

  private readonly origin: string;

  constructor(private readonly config: LocalDriverConfig) {
    if (!config.secret) {
      throw new StorageConfigurationError('storage: STORAGE_UPLOAD_SECRET is required');
    }
    if (!config.directory) {
      throw new StorageConfigurationError('storage: STORAGE_LOCAL_DIR is required');
    }
    this.origin = config.baseUrl.replace(/\/+$/, '');
    this.publicBaseUrl = `${this.origin}/media`;
  }

  presignUpload(input: PresignUploadInput): PresignedUpload {
    const key = `${input.visibility}/${input.key.replace(/^\/+/, '').replace(/^(public|private)\//, '')}`;
    const now = input.now ?? new Date();
    const expires = Math.floor(now.getTime() / 1_000) + input.expiresInSeconds;
    const token: LocalToken = {
      method: 'PUT',
      key,
      contentType: input.contentType,
      expires,
    };

    const query = new URLSearchParams({
      key,
      type: input.contentType,
      expires: String(expires),
      signature: signLocalToken(token, this.config.secret),
    });

    return {
      key,
      url: `${this.origin}/media/upload?${query.toString()}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expires_at: new Date(expires * 1_000).toISOString(),
    };
  }

  presignDownload(input: PresignDownloadInput): string {
    const key = input.key.replace(/^\/+/, '');
    const expires =
      Math.floor((input.now ?? new Date()).getTime() / 1_000) + input.expiresInSeconds;
    const query = new URLSearchParams({
      expires: String(expires),
      signature: signLocalToken(
        { method: 'GET', key, contentType: '', expires },
        this.config.secret,
      ),
    });
    return `${this.origin}/media/${key}?${query.toString()}`;
  }
}

export function signLocalToken(token: LocalToken, secret: string): string {
  const payload = [token.method, token.key, token.contentType, token.expires].join('\n');
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Constant-time check of a token against the secret and the clock.
 *
 * Compares before it checks expiry so a caller cannot learn whether a forged
 * signature was "merely expired" — and uses `timingSafeEqual` so it cannot be
 * recovered a byte at a time from response latency.
 */
export function verifyLocalToken(
  token: LocalToken,
  signature: string,
  secret: string,
  now: Date = new Date(),
): boolean {
  const expected = Buffer.from(signLocalToken(token, secret), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  if (!timingSafeEqual(expected, given)) return false;
  return token.expires * 1_000 > now.getTime();
}

/**
 * Maps a key to a path inside `directory`, refusing anything that escapes it.
 *
 * Keys reaching this are signed, so traversal would already need the secret —
 * but a single missed check is the whole filesystem, and one shared helper used
 * by both the read and the write route is cheaper than trusting two callers to
 * remember.
 */
export function resolveLocalPath(directory: string, key: string): string {
  const root = resolve(directory);
  if (isAbsolute(key)) {
    throw new StorageConfigurationError('storage: absolute keys are not allowed');
  }
  // Refuse, never sanitise. Stripping the `..` segments out of
  // `../../etc/passwd` would answer 200 for an object the caller did not ask
  // for, which is a worse failure than the traversal it was meant to prevent.
  const target = resolve(join(root, normalize(key)));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new StorageConfigurationError(`storage: key "${key}" escapes the storage directory`);
  }
  return target;
}
