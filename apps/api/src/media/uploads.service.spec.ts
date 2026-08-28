import { describe, expect, it } from 'vitest';
import {
  LocalDiskDriver,
  NullStorageDriver,
  StorageNotConfiguredError,
} from '@installment/storage-client';
import { UploadsService } from './uploads.service';
import { UploadNotAllowedError, type UploadPurpose } from './upload-policy';

const MERCHANT_PURPOSES: UploadPurpose[] = ['product_image', 'store_logo', 'store_banner'];
const CUSTOMER_PURPOSES: UploadPurpose[] = ['kyc_document'];

function service(): UploadsService {
  return new UploadsService(
    new LocalDiskDriver({
      baseUrl: 'http://localhost:3000',
      directory: '/tmp/ejua-media',
      secret: 'test-secret',
    }),
    { maxUploadBytes: 1_000_000, uploadTtlSeconds: 300 },
  );
}

describe('UploadsService.request', () => {
  it('mints a URL scoped to the caller', () => {
    const result = service().request(
      { purpose: 'product_image', content_type: 'image/jpeg' },
      'merchant-1',
      MERCHANT_PURPOSES,
    );

    expect(result.key).toMatch(/^public\/products\/merchant-1\//);
    expect(result.method).toBe('PUT');
    expect(result.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  /**
   * The allowlist is per surface, not per role check inside one handler: a
   * merchant token reaching the merchant route can only ever produce merchant
   * keys, whatever the body says.
   */
  it('refuses a purpose this surface does not issue', () => {
    expect(() =>
      service().request(
        { purpose: 'kyc_document', content_type: 'image/jpeg' },
        'merchant-1',
        MERCHANT_PURPOSES,
      ),
    ).toThrow(UploadNotAllowedError);
  });

  it('refuses a catalogue purpose from the customer surface', () => {
    expect(() =>
      service().request(
        { purpose: 'product_image', content_type: 'image/jpeg' },
        'cust-1',
        CUSTOMER_PURPOSES,
      ),
    ).toThrow(UploadNotAllowedError);
  });

  it('validates the body before deriving anything', () => {
    expect(() =>
      service().request({ content_type: 'image/jpeg' }, 'm1', MERCHANT_PURPOSES),
    ).toThrow();
  });

  it('carries the deployment TTL into the URL, not a caller-chosen one', () => {
    const result = service().request(
      { purpose: 'product_image', content_type: 'image/jpeg', expires_in_seconds: 86_400 },
      'merchant-1',
      MERCHANT_PURPOSES,
    );
    const expires = Number(new URL(result.url).searchParams.get('expires'));

    expect(expires * 1_000 - Date.now()).toBeLessThanOrEqual(300_000);
  });
});

describe('UploadsService.readPrivate', () => {
  it('signs a link to a private object', () => {
    const { url, expires_at } = service().readPrivate('private/kyc/c1/card.jpg');

    expect(url).toContain('/media/private/kyc/c1/card.jpg?');
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a public key, which needs no signature to begin with', () => {
    // Signing one would imply the object is protected when anyone holding the
    // URL can already fetch it.
    expect(() => service().readPrivate('public/products/a.jpg')).toThrow(UploadNotAllowedError);
  });
});

describe('UploadsService without storage', () => {
  const disabled = new UploadsService(new NullStorageDriver(), {
    maxUploadBytes: 1_000_000,
    uploadTtlSeconds: 300,
  });

  it('reports itself unconfigured', () => {
    expect(disabled.configured).toBe(false);
    expect(service().configured).toBe(true);
  });

  it('refuses loudly rather than returning a URL that goes nowhere', () => {
    expect(() =>
      disabled.request(
        { purpose: 'product_image', content_type: 'image/jpeg' },
        'm1',
        MERCHANT_PURPOSES,
      ),
    ).toThrow(StorageNotConfiguredError);
  });
});

describe('UploadsService.limits', () => {
  it('tells a client what it may send, so a picker can filter first', () => {
    expect(service().limits(MERCHANT_PURPOSES)).toEqual({
      max_bytes: 1_000_000,
      ttl_seconds: 300,
      purposes: [
        { purpose: 'product_image', content_types: ['image/jpeg', 'image/png', 'image/webp'] },
        { purpose: 'store_logo', content_types: ['image/jpeg', 'image/png', 'image/webp'] },
        { purpose: 'store_banner', content_types: ['image/jpeg', 'image/png', 'image/webp'] },
      ],
    });
  });
});
