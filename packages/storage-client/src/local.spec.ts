import { describe, expect, it } from 'vitest';
import { LocalDiskDriver, resolveLocalPath, signLocalToken, verifyLocalToken } from './local';
import { StorageConfigurationError } from './types';

const SECRET = 'dev-upload-secret';
const NOW = new Date('2026-08-28T12:00:00Z');

function driver(): LocalDiskDriver {
  return new LocalDiskDriver({
    baseUrl: 'http://localhost:3000',
    directory: '/var/ejua/media',
    secret: SECRET,
  });
}

function upload(overrides: Partial<Parameters<LocalDiskDriver['presignUpload']>[0]> = {}) {
  return driver().presignUpload({
    key: 'products/merchant-1/photo.jpg',
    contentType: 'image/jpeg',
    visibility: 'public',
    expiresInSeconds: 300,
    now: NOW,
    ...overrides,
  });
}

describe('LocalDiskDriver', () => {
  it('refuses to construct without a signing secret', () => {
    expect(
      () => new LocalDiskDriver({ baseUrl: 'http://x', directory: '/tmp/m', secret: '' }),
    ).toThrow(StorageConfigurationError);
  });

  it('hands back the same shape as S3, so the client cannot tell them apart', () => {
    const result = upload();

    expect(result.method).toBe('PUT');
    expect(result.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(result.expires_at).toBe('2026-08-28T12:05:00.000Z');
    expect(result.url.startsWith('http://localhost:3000/media/upload?')).toBe(true);
  });

  it('applies the same visibility prefix as S3, so keys stay portable between drivers', () => {
    expect(upload().key).toBe('public/products/merchant-1/photo.jpg');
    expect(upload({ key: 'kyc/c9/card.jpg', visibility: 'private' }).key).toBe(
      'private/kyc/c9/card.jpg',
    );
  });

  it('cannot be talked into a public key by a caller-supplied prefix', () => {
    expect(upload({ key: 'public/kyc/c9/card.jpg', visibility: 'private' }).key).toBe(
      'private/kyc/c9/card.jpg',
    );
  });

  it('serves public objects from the API under /media', () => {
    expect(driver().publicBaseUrl).toBe('http://localhost:3000/media');
  });

  it('signs a download that carries its own expiry', () => {
    const url = new URL(
      driver().presignDownload({ key: 'private/kyc/c9/card.jpg', expiresInSeconds: 60, now: NOW }),
    );

    expect(url.pathname).toBe('/media/private/kyc/c9/card.jpg');
    expect(url.searchParams.get('expires')).toBe(String(Math.floor(NOW.getTime() / 1_000) + 60));
    expect(url.searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * The token is the only thing standing between a dev deployment and an open
 * write endpoint, so every fact it commits to is checked here individually: a
 * forged one must fail even when only one field differs.
 */
describe('verifyLocalToken', () => {
  const token = {
    method: 'PUT' as const,
    key: 'public/products/a.jpg',
    contentType: 'image/jpeg',
    expires: Math.floor(NOW.getTime() / 1_000) + 300,
  };
  const signature = signLocalToken(token, SECRET);

  it('accepts the token it signed', () => {
    expect(verifyLocalToken(token, signature, SECRET, NOW)).toBe(true);
  });

  it('rejects a different secret', () => {
    expect(verifyLocalToken(token, signature, 'other-secret', NOW)).toBe(false);
  });

  for (const [field, value] of [
    ['key', 'public/products/somebody-elses.jpg'],
    ['contentType', 'text/html'],
    ['method', 'GET'],
    ['expires', token.expires + 1],
  ] as const) {
    it(`rejects a tampered ${field}`, () => {
      expect(verifyLocalToken({ ...token, [field]: value }, signature, SECRET, NOW)).toBe(false);
    });
  }

  it('rejects a signature of the wrong length without comparing it', () => {
    // timingSafeEqual throws on a length mismatch, so this path must be
    // short-circuited rather than left to raise.
    expect(verifyLocalToken(token, 'deadbeef', SECRET, NOW)).toBe(false);
  });

  it('rejects an expired token even though the signature is valid', () => {
    const later = new Date(token.expires * 1_000 + 1_000);

    expect(verifyLocalToken(token, signature, SECRET, later)).toBe(false);
  });

  it('accepts one still inside its window', () => {
    const later = new Date(token.expires * 1_000 - 1_000);

    expect(verifyLocalToken(token, signature, SECRET, later)).toBe(true);
  });
});

describe('resolveLocalPath', () => {
  it('maps a key to a path under the storage directory', () => {
    expect(resolveLocalPath('/var/ejua/media', 'public/products/a.jpg')).toBe(
      '/var/ejua/media/public/products/a.jpg',
    );
  });

  it.each([
    '../../etc/passwd',
    'public/../../../etc/passwd',
    'public/products/../../../../etc/shadow',
  ])('refuses to escape the directory via %s', (key) => {
    expect(() => resolveLocalPath('/var/ejua/media', key)).toThrow(StorageConfigurationError);
  });

  it('refuses an absolute key', () => {
    expect(() => resolveLocalPath('/var/ejua/media', '/etc/passwd')).toThrow(
      StorageConfigurationError,
    );
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // `/var/ejua/media-backup` starts with `/var/ejua/media` as a string but is
    // not under it; a naive startsWith check would let it through.
    expect(() => resolveLocalPath('/var/ejua/media', '../media-backup/x.jpg')).toThrow(
      StorageConfigurationError,
    );
  });
});
