/**
 * Object-storage keys → URLs a client can actually fetch.
 *
 * `product_images.storage_key`, `stores.logo_key` and friends hold raw keys, not
 * URLs. Every consumer (three web apps and now a phone) would otherwise have to
 * know the bucket layout and rebuild the same string, and moving to signed URLs
 * would mean changing all of them. Resolving server-side keeps that knowledge in
 * one place.
 */
export class MediaService {
  private readonly base: string;

  /**
   * @param baseUrl Public prefix images are served from, e.g.
   *   `https://cdn.ejua.gh/media`. Empty disables resolution — every `url` comes
   *   back `null`, which renders as the placeholder tile rather than a broken
   *   image, so a deployment that has not configured storage degrades quietly.
   */
  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  get configured(): boolean {
    return this.base.length > 0;
  }

  url(key: string | null | undefined): string | null {
    if (!key || !this.configured) return null;
    // An absolute URL in the key column is already resolved — seed data and
    // partner imports both do this — so pass it through untouched.
    if (/^https?:\/\//i.test(key)) return key;
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }
}
