import { describe, expect, it } from 'vitest';
import { MediaService } from './media';

/**
 * The one function every image URL in the system passes through, and it had no
 * test. It decides what a shopper's phone is told to fetch, and — since the
 * storage layer gained a private prefix — what it is *not* told to fetch.
 */
describe('MediaService', () => {
  const media = new MediaService('https://cdn.ejua.gh/media');

  it('joins the base onto a key', () => {
    expect(media.url('public/products/a.jpg')).toBe(
      'https://cdn.ejua.gh/media/public/products/a.jpg',
    );
  });

  it('does not double the separator when the key is rooted', () => {
    expect(media.url('/public/products/a.jpg')).toBe(
      'https://cdn.ejua.gh/media/public/products/a.jpg',
    );
  });

  it('trims a trailing slash off the base', () => {
    expect(new MediaService('https://cdn.ejua.gh/media/').url('public/a.jpg')).toBe(
      'https://cdn.ejua.gh/media/public/a.jpg',
    );
  });

  it('passes an absolute URL through untouched', () => {
    // Seed data and partner imports both put whole URLs in the key column.
    expect(media.url('https://images.example.com/x.jpg')).toBe('https://images.example.com/x.jpg');
  });

  it.each([null, undefined, ''])('resolves %p to null', (key) => {
    expect(media.url(key)).toBeNull();
  });

  it('resolves everything to null when no base is configured', () => {
    // The deliberate quiet degradation: the apps draw a placeholder tile rather
    // than a broken image on a deployment without storage.
    const unconfigured = new MediaService('');

    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.url('public/products/a.jpg')).toBeNull();
  });

  /**
   * A Ghana Card scan is personal data under the Data Protection Act, 2012
   * (Act 843). It lives under `private/`, which the bucket does not serve
   * anonymously — so a URL built for it would look right and 403, inviting a
   * caller to blame storage rather than notice they had leaked the object's
   * location into a public payload.
   */
  it.each(['private/kyc/c1/card.jpg', '/private/kyc/c1/card.jpg'])(
    'refuses to build a public URL for %s',
    (key) => {
      expect(media.url(key)).toBeNull();
    },
  );

  it('does not mistake a key that merely mentions private for a private one', () => {
    expect(media.url('public/products/private-sale.jpg')).toBe(
      'https://cdn.ejua.gh/media/public/products/private-sale.jpg',
    );
  });
});
