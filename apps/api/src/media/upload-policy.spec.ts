import { describe, expect, it } from 'vitest';
import {
  UPLOAD_PURPOSES,
  UploadNotAllowedError,
  deriveUploadKey,
  keyBelongsTo,
  requestUploadSchema,
  uploadKeyPrefix,
} from './upload-policy';

const MAX = 10_485_760;
const MERCHANT = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';

function derive(input: Record<string, unknown>, ownerId?: string) {
  return deriveUploadKey(requestUploadSchema.parse(input), ownerId, MAX);
}

/**
 * The rule this file exists to enforce: **the key is derived here, never
 * supplied by the client.** A client-chosen key is a client-chosen victim — it
 * would let a merchant overwrite a competitor's photograph, write out of the
 * bucket, or drop something private into the public prefix.
 */
describe('deriveUploadKey', () => {
  it('namespaces a product image by the uploading merchant', () => {
    const derived = derive({ purpose: 'product_image', content_type: 'image/jpeg' }, MERCHANT);

    expect(derived.key).toMatch(new RegExp(`^products/${MERCHANT}/[0-9a-f-]{36}\\.jpg$`));
    expect(derived.visibility).toBe('public');
  });

  it('namespaces a KYC document by the customer, and marks it private', () => {
    const derived = derive({ purpose: 'kyc_document', content_type: 'application/pdf' }, 'cust-1');

    expect(derived.key).toMatch(/^kyc\/cust-1\/[0-9a-f-]{36}\.pdf$/);
    expect(derived.visibility).toBe('private');
  });

  it('leaves platform-owned artwork unnamespaced', () => {
    expect(derive({ purpose: 'category_image', content_type: 'image/png' }).key).toMatch(
      /^categories\/[0-9a-f-]{36}\.png$/,
    );
  });

  it('mints a fresh key every time, so an upload never overwrites an object', () => {
    const a = derive({ purpose: 'product_image', content_type: 'image/jpeg' }, MERCHANT);
    const b = derive({ purpose: 'product_image', content_type: 'image/jpeg' }, MERCHANT);

    expect(a.key).not.toBe(b.key);
  });

  it('takes the extension from the content type, never from a filename', () => {
    // The client does not get to say `.html`; the type it declared decides, and
    // the type is what gets pinned into the signature.
    expect(derive({ purpose: 'product_image', content_type: 'image/webp' }, MERCHANT).key).toMatch(
      /\.webp$/,
    );
  });

  it('ignores content-type parameters, which are not part of the type', () => {
    const derived = derive(
      { purpose: 'product_image', content_type: 'image/jpeg; charset=binary' },
      MERCHANT,
    );

    // Signing the parameters too would mean a client sending the bare type
    // fails to verify against a URL we told it to use.
    expect(derived.contentType).toBe('image/jpeg');
    expect(derived.key).toMatch(/\.jpg$/);
  });

  it('normalises the case a client sent the type in', () => {
    expect(
      derive({ purpose: 'product_image', content_type: 'IMAGE/JPEG' }, MERCHANT).contentType,
    ).toBe('image/jpeg');
  });

  it.each(['text/html', 'application/javascript', 'image/svg+xml', 'application/octet-stream'])(
    'refuses %s for a product image',
    (contentType) => {
      // SVG in particular: it is an image to a picker and a script host to a
      // browser, and these objects are served from an origin of ours.
      expect(() =>
        derive({ purpose: 'product_image', content_type: contentType }, MERCHANT),
      ).toThrow(UploadNotAllowedError);
    },
  );

  it('accepts a PDF for a KYC document but not for a product image', () => {
    expect(() =>
      derive({ purpose: 'kyc_document', content_type: 'application/pdf' }, 'c1'),
    ).not.toThrow();
    expect(() =>
      derive({ purpose: 'product_image', content_type: 'application/pdf' }, MERCHANT),
    ).toThrow(UploadNotAllowedError);
  });

  it('refuses a file over the ceiling before minting a URL', () => {
    expect(() =>
      derive(
        { purpose: 'product_image', content_type: 'image/jpeg', content_length: MAX + 1 },
        MERCHANT,
      ),
    ).toThrow(UploadNotAllowedError);
  });

  it('accepts one exactly at the ceiling', () => {
    expect(() =>
      derive(
        { purpose: 'product_image', content_type: 'image/jpeg', content_length: MAX },
        MERCHANT,
      ),
    ).not.toThrow();
  });

  it('refuses an owned purpose with no owner rather than writing to the root', () => {
    expect(() => derive({ purpose: 'product_image', content_type: 'image/jpeg' })).toThrow(
      UploadNotAllowedError,
    );
    expect(() => derive({ purpose: 'kyc_document', content_type: 'image/jpeg' })).toThrow(
      UploadNotAllowedError,
    );
  });

  it('rejects a purpose that is not in the catalogue', () => {
    expect(() =>
      requestUploadSchema.parse({ purpose: 'anything', content_type: 'image/jpeg' }),
    ).toThrow();
  });
});

describe('UPLOAD_PURPOSES', () => {
  it('keeps KYC the only private purpose', () => {
    const priv = Object.entries(UPLOAD_PURPOSES)
      .filter(([, rule]) => rule.visibility === 'private')
      .map(([purpose]) => purpose);

    expect(priv).toEqual(['kyc_document']);
  });

  it('never accepts a type a browser will execute', () => {
    // Every one of these is served from an origin of ours; an executable type
    // among them is stored XSS.
    for (const [purpose, rule] of Object.entries(UPLOAD_PURPOSES)) {
      for (const type of Object.keys(rule.types)) {
        expect(type, `${purpose} accepts ${type}`).not.toMatch(/html|javascript|svg|xml/);
      }
    }
  });
});

/**
 * The same rule from the other side. Keys are derived here and never chosen by
 * a client — but the endpoints that *attach* a key to a row take it back from
 * the client, and without a check a seller could point their own listing at a
 * competitor's photograph. The object is public, so it would render perfectly.
 */
describe('keyBelongsTo', () => {
  const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002';

  /** The prefixed form, which is what a client actually hands back. */
  function issued(ownerId: string): string {
    return `public/${derive({ purpose: 'product_image', content_type: 'image/jpeg' }, ownerId).key}`;
  }

  it('accepts a key this merchant was issued', () => {
    expect(keyBelongsTo('product_image', issued(MERCHANT), MERCHANT)).toBe(true);
  });

  it('refuses another merchant’s key', () => {
    expect(keyBelongsTo('product_image', issued(OTHER), MERCHANT)).toBe(false);
  });

  it('refuses a key that only looks like the prefix', () => {
    // A neighbouring merchant id that starts with ours would pass a naive
    // `includes` or a prefix test with no trailing separator.
    expect(keyBelongsTo('product_image', `public/products/${MERCHANT}-evil/x.jpg`, MERCHANT)).toBe(
      false,
    );
  });

  it('refuses the unprefixed form, which is not what is stored', () => {
    expect(keyBelongsTo('product_image', `products/${MERCHANT}/x.jpg`, MERCHANT)).toBe(false);
  });

  it('refuses a private key offered to a public purpose', () => {
    expect(keyBelongsTo('product_image', `private/kyc/${MERCHANT}/card.jpg`, MERCHANT)).toBe(false);
  });

  it('matches nothing rather than the whole folder when there is no owner', () => {
    expect(keyBelongsTo('product_image', `public/products/${MERCHANT}/x.jpg`, undefined)).toBe(
      false,
    );
  });

  it('has no owner segment for a platform-owned purpose', () => {
    expect(uploadKeyPrefix('category_image', undefined)).toBe('public/categories/');
    expect(keyBelongsTo('category_image', 'public/categories/x.jpg', undefined)).toBe(true);
  });
});
