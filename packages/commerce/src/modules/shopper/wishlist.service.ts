import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { ProductNotFoundError } from '../catalog/errors';
import type { StorefrontProduct, StorefrontService } from '../catalog/storefront.service';

const wl = schema.wishlist_items;
const p = schema.products;

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

  async list(customerId: string): Promise<StorefrontProduct[]> {
    const rows = await this.db
      .select({ product_id: wl.product_id })
      .from(wl)
      .innerJoin(p, eq(p.id, wl.product_id))
      .where(and(eq(wl.customer_id, customerId), isNull(p.deleted_at)))
      .orderBy(desc(wl.created_at));

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.product_id);

    // Fetch as cards so a saved item renders identically to the grid it came
    // from, then restore the saved-at ordering the query above established.
    const cards = await this.storefront.browse({ limit: 100 });
    const byId = new Map(cards.rows.map((c) => [c.id, c]));
    const found = ids.map((id) => byId.get(id)).filter((c): c is StorefrontProduct => Boolean(c));
    if (found.length === ids.length) return found;

    // A saved product that has since been delisted or whose store was suspended
    // is not in the browsable set. Fall back to fetching the ones we missed
    // individually so the list stays complete rather than silently short.
    const missing = ids.filter((id) => !byId.has(id));
    const extra = await Promise.all(
      missing.map((id) => this.storefront.product(id).catch(() => null)),
    );
    const all = new Map(byId);
    for (const item of extra) if (item) all.set(item.id, item);
    return ids.map((id) => all.get(id)).filter((c): c is StorefrontProduct => Boolean(c));
  }

  async ids(customerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ product_id: wl.product_id })
      .from(wl)
      .where(eq(wl.customer_id, customerId));
    return rows.map((r) => r.product_id);
  }

  async count(customerId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(wl)
      .where(eq(wl.customer_id, customerId));
    return rows[0]?.total ?? 0;
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
