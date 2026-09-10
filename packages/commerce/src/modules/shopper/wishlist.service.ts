import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { ProductNotFoundError } from '../catalog/errors';
import {
  liveListingWhere,
  type StorefrontProduct,
  type StorefrontService,
} from '../catalog/storefront.service';

const wl = schema.wishlist_items;
const p = schema.products;
const st = schema.stores;
const merch = schema.merchants;

/**
 * Saved items — the heart on the product screen and the "Saved items" row in
 * the account menu.
 *
 * Adding is idempotent by unique constraint rather than by a read-then-write:
 * a double tap on a phone with a slow connection is the normal case, and
 * `ON CONFLICT DO NOTHING` settles it in one round trip without a race.
 */
export class WishlistService {
  constructor(
    private readonly db: Database,
    private readonly storefront: StorefrontService,
  ) {}

  /**
   * Everything saved that is still a live listing, newest save first.
   *
   * One query for the saved ids, one for their cards. It used to fetch the
   * catalogue's top-100 POPULAR page and look each saved id up in it — two
   * unrelated sets, so in any catalogue over a hundred products almost every
   * saved item missed and fell through to a full per-id detail fetch of about
   * seven queries. Thirty saved items was roughly two hundred round trips to
   * open one screen, and the response was heterogeneous with it: the hits came
   * back as thin `StorefrontProduct` cards and the misses as full
   * `StorefrontProductDetails`, two shapes in one array that the OpenAPI
   * contract documented as one.
   *
   * A saved product whose seller has been suspended, or whose listing has been
   * archived, is simply absent. The old fallback's comment claimed it kept such
   * items "so the list stays complete rather than silently short" — it did not:
   * `product()` applies the same liveness predicate and throws, and the
   * `.catch(() => null)` swallowed it. Dropping them is the right behaviour;
   * only the comment was wrong.
   */
  async list(customerId: string): Promise<StorefrontProduct[]> {
    const saved = await this.savedIds(customerId);
    if (saved.length === 0) return [];

    const cards = await this.storefront.cardsByIds(saved);
    // Saved-at order, which `cardsByIds` does not preserve and should not have
    // to: the ordering belongs to the wishlist, not to the catalogue.
    return saved.map((id) => cards.get(id)).filter((c): c is StorefrontProduct => Boolean(c));
  }

  /**
   * The ids the heart is filled for.
   *
   * Deliberately NOT filtered to live listings, and deliberately different from
   * `list`. This answers "did I save this?" on a product screen the shopper is
   * already looking at — and a product page can be open for a listing that has
   * since been archived. Filtering here would empty the heart on a page whose
   * save is real and whose DELETE would still work.
   *
   * `count` is the one that had to change: see below.
   */
  async ids(customerId: string): Promise<string[]> {
    return this.savedIds(customerId);
  }

  /**
   * How many saved items the account screen promises.
   *
   * This was a bare `COUNT(*)` over `wishlist_items` with no product join,
   * while `list` dropped archived products and suspended sellers — so the
   * account screen printed "7 saved" over a list of five, and the mobile client
   * invalidates `['wishlist']` and `['profile']` together, which put both
   * numbers on screen at once.
   *
   * It now counts through the same `liveListingWhere()` the list reads
   * through — the predicate whose own docstring says it exists as ONE exported
   * expression so the seller check cannot go missing from a fifth call site.
   * It was not actually exported until this change, and the wishlist was that
   * fifth call site.
   */
  async count(customerId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(wl)
      .innerJoin(p, eq(p.id, wl.product_id))
      .innerJoin(st, eq(st.id, p.store_id))
      .innerJoin(merch, eq(merch.id, p.merchant_id))
      .where(and(eq(wl.customer_id, customerId), liveListingWhere()));
    return rows[0]?.total ?? 0;
  }

  /** Saved product ids, newest save first, minus hard-deleted products. */
  private async savedIds(customerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ product_id: wl.product_id })
      .from(wl)
      .innerJoin(p, eq(p.id, wl.product_id))
      .where(and(eq(wl.customer_id, customerId), isNull(p.deleted_at)))
      // `wishlist_items.created_at` alone is not unique — two saves inside one
      // transaction share it — and the catalogue's own sorts end at a unique
      // id for exactly that reason.
      .orderBy(desc(wl.created_at), desc(wl.product_id));
    return rows.map((r) => r.product_id);
  }

  async add(customerId: string, productId: string): Promise<void> {
    const exists = await this.db
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.id, productId), isNull(p.deleted_at)))
      .limit(1);
    if (!exists[0]) throw new ProductNotFoundError(productId);

    await this.db
      .insert(wl)
      .values({ customer_id: customerId, product_id: productId })
      .onConflictDoNothing({ target: [wl.customer_id, wl.product_id] });
  }

  async remove(customerId: string, productId: string): Promise<void> {
    await this.db
      .delete(wl)
      .where(and(eq(wl.customer_id, customerId), eq(wl.product_id, productId)));
  }
}
