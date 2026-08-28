import { describe, expect, it } from 'vitest';
import { S3Driver } from './s3';
import { StorageConfigurationError } from './types';

const CREDS = {
  bucket: 'ejua-media',
  region: 'eu-west-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const NOW = new Date('2026-08-28T12:00:00Z');

function upload(
  driver: S3Driver,
  overrides: Partial<Parameters<S3Driver['presignUpload']>[0]> = {},
) {
  return driver.presignUpload({
    key: 'products/merchant-1/photo.jpg',
    contentType: 'image/jpeg',
    visibility: 'public',
    expiresInSeconds: 300,
    now: NOW,
    ...overrides,
  });
}

describe('S3Driver addressing', () => {
  it('addresses AWS virtual-host style', () => {
    const url = upload(new S3Driver(CREDS)).url;

    expect(url.startsWith('https://ejua-media.s3.eu-west-1.amazonaws.com/public/products/')).toBe(
      true,
    );
  });

  it('puts the bucket in the path for R2 and MinIO', () => {
    const driver = new S3Driver({
      ...CREDS,
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      forcePathStyle: true,
    });

    expect(upload(driver).url).toContain(
      'https://abc123.r2.cloudflarestorage.com/ejua-media/public/products/',
    );
  });

  it('prefixes the bucket onto the endpoint host for Spaces', () => {
    const driver = new S3Driver({ ...CREDS, endpoint: 'https://fra1.digitaloceanspaces.com' });

    expect(upload(driver).url).toContain('https://ejua-media.fra1.digitaloceanspaces.com/public/');
  });

  it('refuses an endpoint that is not a URL', () => {
    expect(() => new S3Driver({ ...CREDS, endpoint: 'fra1.digitaloceanspaces.com' })).toThrow(
      StorageConfigurationError,
    );
  });

  it('refuses to construct without credentials', () => {
    expect(() => new S3Driver({ ...CREDS, secretAccessKey: '' })).toThrow(
      StorageConfigurationError,
    );
  });
});

/**
 * The visibility prefix is the whole privacy control: a Ghana Card photograph
 * under `public/` is world-readable to anyone who learns the key. So the driver
 * derives it rather than trusting what it was handed — a policy layer that
 * passes a public-looking key for a private upload must still get `private/`.
 */
describe('S3Driver visibility', () => {
  it('files public objects under public/', () => {
    expect(upload(new S3Driver(CREDS)).key).toBe('public/products/merchant-1/photo.jpg');
  });

  it('files private objects under private/', () => {
    const result = upload(new S3Driver(CREDS), {
      key: 'kyc/customer-9/card.jpg',
      visibility: 'private',
    });

    expect(result.key).toBe('private/kyc/customer-9/card.jpg');
  });

  it('cannot be talked into a public key by a caller-supplied prefix', () => {
    const result = upload(new S3Driver(CREDS), {
      key: 'public/kyc/customer-9/card.jpg',
      visibility: 'private',
    });

    expect(result.key).toBe('private/kyc/customer-9/card.jpg');
  });

  it('does not double the prefix when the caller already applied the right one', () => {
    expect(upload(new S3Driver(CREDS), { key: 'public/products/a.jpg' }).key).toBe(
      'public/products/a.jpg',
    );
  });

  it('rejects an empty key', () => {
    expect(() => upload(new S3Driver(CREDS), { key: '/' })).toThrow(StorageConfigurationError);
  });
});

describe('S3Driver presignUpload', () => {
  it('pins the content type into the signature and asks the client to send it', () => {
    const result = upload(new S3Driver(CREDS));

    expect(new URL(result.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(result.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('reports the expiry as a wall-clock instant, not a duration', () => {
    // The client shows "this link expires at", and cannot subtract a duration
    // from a clock it does not share with the server.
    expect(upload(new S3Driver(CREDS)).expires_at).toBe('2026-08-28T12:05:00.000Z');
  });

  it('always asks for a PUT', () => {
    expect(upload(new S3Driver(CREDS)).method).toBe('PUT');
  });

  it('signs a different URL for a different content type', () => {
    const jpeg = upload(new S3Driver(CREDS));
    const png = upload(new S3Driver(CREDS), { contentType: 'image/png' });

    expect(png.url).not.toBe(jpeg.url);
  });
});

describe('S3Driver presignDownload', () => {
  it('signs a GET for a private key', () => {
    const url = new S3Driver(CREDS).presignDownload({
      key: 'private/kyc/customer-9/card.jpg',
      expiresInSeconds: 60,
      now: NOW,
    });

    expect(url).toContain('/private/kyc/customer-9/card.jpg?');
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60');
    // No content type is pinned on a read: there is no body to constrain.
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('S3Driver publicBaseUrl', () => {
  it('trims a trailing slash so joins do not double it', () => {
    expect(new S3Driver({ ...CREDS, publicBaseUrl: 'https://cdn.ejua.gh/' }).publicBaseUrl).toBe(
      'https://cdn.ejua.gh',
    );
  });

  it('is empty when no public prefix is configured, which disables image URLs', () => {
    expect(new S3Driver(CREDS).publicBaseUrl).toBe('');
  });
});
