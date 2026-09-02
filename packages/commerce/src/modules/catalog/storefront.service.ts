import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { StoreNotFoundError } from '../stores/errors';
import { ProductNotFoundError } from './errors';
import type { MediaService } from './media';
import {
  browseProductsSchema,
  homeFeedSchema,
  listReviewsSchema,
  trendingSchema,
  type BrowseProductsInput,
  type HomeFeedInput,
  type ListReviewsInput,
  type ProductSort,
  type TrendingInput,
} from './storefront.dto';

const p = schema.products;
const pv = schema.product_variants;
const pi = schema.product_images;
const inv = schema.inventory;
const ppo = schema.product_plan_offers;
const st = schema.stores;
const merch = schema.merchants;
const cat = schema.categories;
const rev = schema.product_reviews;
const sq = schema.search_queries;

/** Order statuses that mean the customer actually took delivery of the goods. */
/**
 * What makes a product publicly visible: the product, its store AND its seller
 * all live.
 *
 * The seller half was missing. `merchants.status` was checked nowhere on the
 * public surface, so suspending a merchant left their shopfront listed and
 * their goods on sale — verified by suspending one and watching the storefront
 * keep serving them, then checking out a GHS 1,200 order against them.
 *
 * It is one exported expression rather than a predicate repeated at each call
 * site, because that is how the seller check went missing from four places at
 * once: whoever adds the fifth read gets it for free.
 */
function liveListingWhere(): SQL {
  return and(
    isNull(p.deleted_at),
    eq(p.status, 'active'),
    eq(st.status, 'active'),
    isNull(st.deleted_at),
    eq(merch.status, 'active'),
    isNull(merch.deleted_at),
  )!;
}

const SOLD_STATUSES = [
  'paid',
  'financing_active',
  'fulfilling',
  'shipped',
  'delivered',
  'completed',
] as const;

/**
 * `SOLD_STATUSES` as a SQL list.
 *
 * Interpolating the array into a `sql` template binds it as ONE parameter, which
 * Postgres reads as a single text value and matches nothing; joining the values
 * as separate placeholders is what makes `IN` behave.
 */
const SOLD_STATUS_LIST = sql.join(
  SOLD_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * A product as a shopping app renders it: the row plus the four things every
 * card in the design shows and the bare table could not supply — an image URL,
 * the vendor's name, what it is worth against its "was" price, and whether it
 * can be bought on instalments.
 */
export interface StorefrontProduct {
  id: string;
  store_id: string;
  merchant_id: string;
  category_id: string | null;
  title: string;
  base_price_pesewas: number;
  compare_at_price_pesewas: number | null;
  /** Whole percent off, or null when there is no comparison price. */
  discount_percent: number | null;
  deal_ends_at: string | null;
  currency: string;
  primary_image_url: string | null;
  primary_image_alt: string | null;
  store_slug: string;
  store_display_name: string;
  store_logo_url: string | null;
  store_verified: boolean;
  rating_avg: number | null;
  rating_count: number;
  sold_count: number;
  installment_eligible: boolean;
  in_stock: boolean;
  created_at: string;
}

export interface StorefrontStore {
  id: string;
  slug: string;
  display_name: string;
  about: string | null;
  city: string | null;
  region: string | null;
  verified: boolean;
  logo_url: string | null;
  banner_url: string | null;
  support_phone: string | null;
  joined_at: string;
  product_count: number;
  rating_avg: number | null;
  rating_count: number;
  order_count: number;
  /** Share of the store's delivered orders that arrived by their ETA, 0–100. */
  on_time_percent: number | null;
}

export interface StorefrontCategory {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;
  image_url: string | null;
  accent_hex: string | null;
  product_count: number;
}

export interface StorefrontProductDetails extends StorefrontProduct {
  description: string | null;
  attributes: Record<string, unknown>;
  images: { id: string; url: string | null; alt_text: string | null; position: number }[];
  variants: {
    id: string;
    sku: string;
    option_values: Record<string, unknown>;
    price_pesewas: number | null;
    /** The price actually charged: the variant's override, else the product's base. */
    effective_price_pesewas: number;
    is_active: boolean;
    quantity_available: number;
  }[];
  /** The option axis the variant picker labels itself with, e.g. "SIZE". */
  variant_label: string | null;
  plan_template_ids: string[];
  store: StorefrontStore;
  category: { id: string; name: string; slug: string } | null;
}

export interface StorefrontReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  author: string;
  created_at: string;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
}

export interface HomeFeed {
  categories: StorefrontCategory[];
  /** Products inside a live deal window, soonest to expire first. */
  deals: StorefrontProduct[];
  /** When the earliest live deal ends — what the countdown counts down to. */
  deals_end_at: string | null;
  /** The merchandising rail: things you can take home on instalments. */
  installment_picks: StorefrontProduct[];
  newest: StorefrontProduct[];
}

/**
 * Every read the shopping apps make against the catalogue.
 *
 * Kept apart from `ProductsService` (which is merchant/admin CRUD) because the
 * two answer different questions: that one owns what a seller may write, this
 * one owns what a shopper may see. Everything here is implicitly filtered to
 * active products in active stores — a suspended store's goods must not be
 * purchasable, which the old shared `list()` got wrong.
 */
export class StorefrontService {
  constructor(
    private readonly db: Database,
    private readonly media: MediaService,
  ) {}

  // ------------------------------------------------------------------ browse

  async browse(rawInput: unknown = {}): Promise<Paginated<StorefrontProduct>> {
    const input: BrowseProductsInput = browseProductsSchema.parse(rawInput);
    const where = await this.browseWhere(input);
    const rows = await this.selectCards(
      where,
      this.orderFor(input.sort, input.q),
      input.limit,
      input.offset,
    );
    const total = await this.count(where);
    return { rows, total };
  }

  /**
   * Full-text search, and the record of it.
   *
   * The search is logged (term, city, result count) because "TRENDING IN ACCRA"
   * has to come from somewhere real; the alternative was a hard-coded list that
   * would be wrong the day it shipped. Logging is best-effort — a failed insert
   * must never lose the customer their search results.
   */
  async search(
    rawInput: unknown,
    context: { customerId?: string; city?: string } = {},
  ): Promise<Paginated<StorefrontProduct>> {
    const input: BrowseProductsInput = browseProductsSchema.parse(rawInput);
    const term = input.q?.trim() ?? '';
    const result = await this.browse({ ...input, q: term, sort: input.sort });
    if (term) {
      try {
        await this.db.insert(sq).values({
          term,
          normalised: normaliseTerm(term),
          city: context.city ?? null,
          customer_id: context.customerId ?? null,
          result_count: result.total,
        });
      } catch {
        /* discovery analytics must never break discovery */
      }
    }
    return result;
  }

  async trending(rawInput: unknown = {}): Promise<{ term: string; searches: number }[]> {
    const input: TrendingInput = trendingSchema.parse(rawInput);
    const since = sql`NOW() - ${`${input.days} days`}::interval`;
    const where = input.city
      ? and(gte(sq.created_at, since), eq(sq.city, input.city))
      : gte(sq.created_at, since);

    const rows = await this.db
      .select({
        term: sql<string>`MIN(${sq.term})`,
        searches: sql<number>`COUNT(*)::int`,
      })
      .from(sq)
      // A term nobody found anything for is not a trend worth showing; it is a
      // gap in the catalogue, which is an ops problem, not a shopper's.
      .where(and(where, sql`${sq.result_count} > 0`))
      .groupBy(sq.normalised)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(input.limit);
    return rows;
  }

  // ----------------------------------------------------------------- product

  async product(id: string): Promise<StorefrontProductDetails> {
    const cards = await this.selectCards(
      and(eq(p.id, id), liveListingWhere()),
      [desc(p.created_at)],
      1,
      0,
    );
    const card = cards[0];
    if (!card) throw new ProductNotFoundError(id);

    const [images, variantRows, offers, store, category] = await Promise.all([
      this.db.select().from(pi).where(eq(pi.product_id, id)).orderBy(asc(pi.position)),
      this.db
        .select()
        .from(pv)
        .leftJoin(inv, eq(inv.variant_id, pv.id))
        .where(eq(pv.product_id, id))
        .orderBy(asc(pv.created_at)),
      this.db
        .select({ plan_template_id: ppo.plan_template_id })
        .from(ppo)
        .where(and(eq(ppo.product_id, id), eq(ppo.is_active, true))),
      this.storeById(card.store_id),
      this.categoryOf(card.category_id),
    ]);

    const detailRows = await this.db
      .select({ description: p.description, attributes: p.attributes })
      .from(p)
      .where(eq(p.id, id))
      .limit(1);
    const detail = detailRows[0];

    // Inactive variants stay in the table for order history but must never be
    // offered — a picker that shows a size nobody can buy is a dead end.
    const variants = variantRows
      .filter((r) => r.product_variants.is_active)
      .map((r) => ({
        id: r.product_variants.id,
        sku: r.product_variants.sku,
        option_values: (r.product_variants.option_values ?? {}) as Record<string, unknown>,
        price_pesewas: r.product_variants.price_pesewas,
        effective_price_pesewas: r.product_variants.price_pesewas ?? card.base_price_pesewas,
        is_active: r.product_variants.is_active,
        quantity_available: Math.max(
          0,
          (r.inventory?.quantity_available ?? 0) - (r.inventory?.quantity_reserved ?? 0),
        ),
      }));

    return {
      ...card,
      description: detail?.description ?? null,
      attributes: (detail?.attributes ?? {}) as Record<string, unknown>,
      images: images.map((img) => ({
        id: img.id,
        url: this.media.url(img.storage_key),
        alt_text: img.alt_text,
        position: img.position,
      })),
      variants,
      variant_label: variantLabel(variants.map((v) => v.option_values)),
      plan_template_ids: offers.map((o) => o.plan_template_id),
      store,
      category,
    };
  }

  async reviews(productId: string, rawInput: unknown = {}): Promise<Paginated<StorefrontReview>> {
    const input: ListReviewsInput = listReviewsSchema.parse(rawInput);
    const cu = schema.customers;
    const where = and(eq(rev.product_id, productId), eq(rev.status, 'published'));

    const rows = await this.db
      .select({
        id: rev.id,
        rating: rev.rating,
        title: rev.title,
        body: rev.body,
        first_name: cu.first_name,
        last_name: cu.last_name,
        created_at: rev.created_at,
      })
      .from(rev)
      .innerJoin(cu, eq(cu.id, rev.customer_id))
      .where(where)
      .orderBy(desc(rev.created_at))
      .limit(input.limit)
      .offset(input.offset);

    const totals = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(rev)
      .where(where);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        // Reviews are public; a full surname is more identification than a
        // shopper agreed to when they rated a kettle.
        author: `${r.first_name} ${(r.last_name ?? '').slice(0, 1)}`.trim(),
        created_at: r.created_at,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  // ------------------------------------------------------------------- store

  async store(slug: string): Promise<StorefrontStore> {
    const rows = await this.db
      .select({ id: st.id })
      .from(st)
      .innerJoin(merch, eq(merch.id, st.merchant_id))
      .where(
        and(
          eq(st.slug, slug),
          eq(st.status, 'active'),
          isNull(st.deleted_at),
          eq(merch.status, 'active'),
          isNull(merch.deleted_at),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new StoreNotFoundError(slug);
    return this.storeById(row.id);
  }

  // -------------------------------------------------------------- categories

  async categories(): Promise<StorefrontCategory[]> {
    const rows = await this.db
      .select({
        id: cat.id,
        parent_id: cat.parent_id,
        name: cat.name,
        slug: cat.slug,
        position: cat.position,
        image_key: cat.image_key,
        accent_hex: cat.accent_hex,
        product_count: sql<number>`(
          SELECT COUNT(*)::int FROM products pr
          JOIN stores s ON s.id = pr.store_id
          WHERE pr.category_id = categories.id
            AND pr.status = 'active' AND pr.deleted_at IS NULL
            AND s.status = 'active' AND s.deleted_at IS NULL
        )`,
      })
      .from(cat)
      .where(eq(cat.is_active, true))
      .orderBy(asc(cat.position), asc(cat.name));

    return rows.map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      name: r.name,
      slug: r.slug,
      position: r.position,
      image_url: this.media.url(r.image_key),
      accent_hex: r.accent_hex,
      product_count: r.product_count,
    }));
  }

  // -------------------------------------------------------------------- home

  /**
   * The home screen in one round trip.
   *
   * A phone on a Ghanaian mobile network pays for every request in latency, so
   * the four rails the design shows are assembled server-side rather than by
   * four parallel calls that each re-run the same joins.
   */
  async home(rawInput: unknown = {}): Promise<HomeFeed> {
    const input: HomeFeedInput = homeFeedSchema.parse(rawInput);
    void input.city; // reserved: city-scoped merchandising is a later slice

    const live = liveListingWhere();

    const [categories, deals, installmentPicks, newest] = await Promise.all([
      this.categories(),
      this.selectCards(and(live, this.liveDealExpr()), [asc(p.deal_ends_at)], 8, 0),
      this.selectCards(and(live, this.installmentEligibleExpr()), this.orderFor('popular'), 8, 0),
      this.selectCards(live, [desc(p.created_at)], 8, 0),
    ]);

    return {
      categories,
      deals,
      // The soonest expiry is what the countdown must track: a single timer over
      // a mixed carousel has to end when the first deal does, or it keeps
      // ticking against an offer that already lapsed.
      deals_end_at: deals.reduce<string | null>(
        (soonest, d) =>
          d.deal_ends_at && (!soonest || d.deal_ends_at < soonest) ? d.deal_ends_at : soonest,
        null,
      ),
      installment_picks: installmentPicks,
      newest,
    };
  }

  // ---------------------------------------------------------------- internal

  private async browseWhere(input: BrowseProductsInput): Promise<SQL | undefined> {
    // The joins to stores and merchants are always present, so an inactive or
    // soft-deleted store — or a merchant who is suspended, offboarded or still
    // pending KYC — drops out of every public read here.
    const where: (SQL | undefined)[] = [liveListingWhere()];

    if (input.category_id) where.push(eq(p.category_id, input.category_id));
    if (input.category_slug) {
      where.push(
        sql`products.category_id IN (SELECT c.id FROM categories c WHERE c.slug = ${input.category_slug})`,
      );
    }
    if (input.store_id) where.push(eq(p.store_id, input.store_id));
    if (input.store_slug) where.push(eq(st.slug, input.store_slug));
    if (input.min_price_pesewas !== undefined) {
      where.push(gte(p.base_price_pesewas, input.min_price_pesewas));
    }
    if (input.max_price_pesewas !== undefined) {
      where.push(lte(p.base_price_pesewas, input.max_price_pesewas));
    }
    if (input.installment_only) where.push(this.installmentEligibleExpr());
    if (input.in_stock) where.push(sql`${this.inStockExpr()}`);
    if (input.deals_only) where.push(this.liveDealExpr());

    const term = input.q?.trim();
    if (term) {
      // plainto_tsquery handles the ordinary case; a shopper typing a partial
      // word ("ank") produces no lexeme match at all, so a prefix fallback on
      // the title keeps short queries from returning an empty screen.
      where.push(
        sql`(products.search_tsv @@ plainto_tsquery('english', ${term})
             OR products.title ILIKE ${'%' + term + '%'})`,
      );
    }

    return and(...where.filter(Boolean));
  }

  private liveDealExpr(): SQL {
    return sql`products.deal_ends_at IS NOT NULL AND products.deal_ends_at > NOW()`;
  }

  private installmentEligibleExpr(): SQL {
    return sql`EXISTS (SELECT 1 FROM product_plan_offers o
      WHERE o.product_id = products.id AND o.is_active)`;
  }

  private inStockExpr(): SQL {
    return sql`EXISTS (
      SELECT 1 FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.product_id = products.id AND v.is_active
        AND i.quantity_available - i.quantity_reserved > 0
    )`;
  }

  private orderFor(sort: ProductSort, term?: string): SQL[] {
    switch (sort) {
      case 'price_asc':
        return [asc(p.base_price_pesewas), desc(p.created_at)];
      case 'price_desc':
        return [desc(p.base_price_pesewas), desc(p.created_at)];
      case 'rating':
        // NULLS LAST so an unrated product does not outrank a five-star one.
        return [sql`${this.ratingAvgExpr()} DESC NULLS LAST`, desc(p.created_at)];
      case 'newest':
        return [desc(p.created_at)];
      case 'popular':
      default:
        // With a search term, relevance leads and popularity breaks ties;
        // without one, popularity is all there is to go on.
        return term?.trim()
          ? [
              sql`ts_rank(products.search_tsv, plainto_tsquery('english', ${term.trim()})) DESC`,
              sql`${this.soldCountExpr()} DESC`,
              desc(p.created_at),
            ]
          : [sql`${this.soldCountExpr()} DESC`, desc(p.created_at)];
    }
  }

  private ratingAvgExpr(): SQL {
    return sql`(SELECT AVG(r.rating)::numeric(3,2) FROM product_reviews r
      WHERE r.product_id = products.id AND r.status = 'published')`;
  }

  private soldCountExpr(): SQL {
    return sql`(SELECT COALESCE(SUM(it.quantity), 0)::int FROM order_items it
      JOIN orders o ON o.id = it.order_id
      WHERE it.product_id = products.id AND o.status IN (${SOLD_STATUS_LIST}))`;
  }

  private async count(where: SQL | undefined): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(p)
      .innerJoin(st, eq(st.id, p.store_id))
      .innerJoin(merch, eq(merch.id, p.merchant_id))
      .where(where);
    return rows[0]?.total ?? 0;
  }

  private async selectCards(
    where: SQL | undefined,
    orderBy: SQL[],
    limit: number,
    offset: number,
  ): Promise<StorefrontProduct[]> {
    const rows = await this.db
      .select({
        id: p.id,
        store_id: p.store_id,
        merchant_id: p.merchant_id,
        category_id: p.category_id,
        title: p.title,
        base_price_pesewas: p.base_price_pesewas,
        compare_at_price_pesewas: p.compare_at_price_pesewas,
        deal_ends_at: p.deal_ends_at,
        currency: p.currency,
        created_at: p.created_at,
        store_slug: st.slug,
        store_display_name: st.display_name,
        store_logo_key: st.logo_key,
        store_verified_at: st.verified_at,
        primary_image_key: sql<string | null>`(SELECT im.storage_key FROM product_images im
          WHERE im.product_id = products.id ORDER BY im.position, im.created_at LIMIT 1)`,
        primary_image_alt: sql<string | null>`(SELECT im.alt_text FROM product_images im
          WHERE im.product_id = products.id ORDER BY im.position, im.created_at LIMIT 1)`,
        rating_avg: sql<string | null>`${this.ratingAvgExpr()}`,
        rating_count: sql<number>`(SELECT COUNT(*)::int FROM product_reviews r
          WHERE r.product_id = products.id AND r.status = 'published')`,
        sold_count: sql<number>`${this.soldCountExpr()}`,
        installment_eligible: sql<boolean>`${this.installmentEligibleExpr()}`,
        in_stock: sql<boolean>`${this.inStockExpr()}`,
      })
      .from(p)
      .innerJoin(st, eq(st.id, p.store_id))
      .innerJoin(merch, eq(merch.id, p.merchant_id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      id: r.id,
      store_id: r.store_id,
      merchant_id: r.merchant_id,
      category_id: r.category_id,
      title: r.title,
      base_price_pesewas: r.base_price_pesewas,
      compare_at_price_pesewas: r.compare_at_price_pesewas,
      discount_percent: discountPercent(r.base_price_pesewas, r.compare_at_price_pesewas),
      deal_ends_at: r.deal_ends_at,
      currency: r.currency,
      primary_image_url: this.media.url(r.primary_image_key),
      primary_image_alt: r.primary_image_alt,
      store_slug: r.store_slug,
      store_display_name: r.store_display_name,
      store_logo_url: this.media.url(r.store_logo_key),
      store_verified: r.store_verified_at !== null,
      // AVG comes back as a numeric string from pg; a client that sorts or
      // compares it as a string would order 4.9 above 5.0.
      rating_avg: r.rating_avg === null ? null : Number(r.rating_avg),
      rating_count: r.rating_count,
      sold_count: r.sold_count,
      installment_eligible: r.installment_eligible,
      in_stock: r.in_stock,
      created_at: r.created_at,
    }));
  }

  private async storeById(id: string): Promise<StorefrontStore> {
    const rows = await this.db
      .select({
        id: st.id,
        slug: st.slug,
        display_name: st.display_name,
        about: st.about,
        city: st.city,
        region: st.region,
        verified_at: st.verified_at,
        logo_key: st.logo_key,
        banner_key: st.banner_key,
        support_phone: st.support_phone,
        created_at: st.created_at,
        product_count: sql<number>`(SELECT COUNT(*)::int FROM products pr
          WHERE pr.store_id = stores.id AND pr.status = 'active' AND pr.deleted_at IS NULL)`,
        rating_avg: sql<string | null>`(SELECT AVG(r.rating)::numeric(3,2) FROM product_reviews r
          WHERE r.store_id = stores.id AND r.status = 'published')`,
        rating_count: sql<number>`(SELECT COUNT(*)::int FROM product_reviews r
          WHERE r.store_id = stores.id AND r.status = 'published')`,
        order_count: sql<number>`(SELECT COUNT(*)::int FROM orders o
          WHERE o.store_id = stores.id AND o.status IN (${SOLD_STATUS_LIST}))`,
        on_time_percent: sql<string | null>`(
          SELECT ROUND(100.0 * COUNT(*) FILTER (
                   WHERE sh.delivered_at IS NOT NULL
                     AND (sh.eta_at IS NULL OR sh.delivered_at <= sh.eta_at)
                 ) / NULLIF(COUNT(*), 0))
          FROM shipments sh
          JOIN orders o ON o.id = sh.order_id
          WHERE o.store_id = stores.id AND sh.delivered_at IS NOT NULL
        )`,
      })
      .from(st)
      .where(and(eq(st.id, id), isNull(st.deleted_at)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new StoreNotFoundError(id);

    return {
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      about: row.about,
      city: row.city,
      region: row.region,
      verified: row.verified_at !== null,
      logo_url: this.media.url(row.logo_key),
      banner_url: this.media.url(row.banner_key),
      support_phone: row.support_phone,
      joined_at: row.created_at,
      product_count: row.product_count,
      rating_avg: row.rating_avg === null ? null : Number(row.rating_avg),
      rating_count: row.rating_count,
      order_count: row.order_count,
      on_time_percent: row.on_time_percent === null ? null : Number(row.on_time_percent),
    };
  }

  private async categoryOf(
    id: string | null,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    if (!id) return null;
    const rows = await this.db
      .select({ id: cat.id, name: cat.name, slug: cat.slug })
      .from(cat)
      .where(eq(cat.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Whole percent off the "was" price, or null when there is nothing to compare. */
function discountPercent(price: number, compareAt: number | null): number | null {
  if (!compareAt || compareAt <= price) return null;
  return Math.round((1 - price / compareAt) * 100);
}

/**
 * The axis a variant picker labels itself with.
 *
 * Variants carry free-form `option_values` ({"size":"L"}), and the design's
 * picker has a single heading — SIZE, STORAGE, SCENT. Take the one key every
 * variant shares; with none (or several) there is no honest heading, so the
 * picker falls back to unlabelled chips rather than guessing.
 */
function variantLabel(optionValues: Record<string, unknown>[]): string | null {
  if (optionValues.length === 0) return null;
  const first = optionValues[0];
  if (!first) return null;
  const shared = Object.keys(first).filter((key) => optionValues.every((values) => key in values));
  return shared.length === 1 ? shared[0]!.toUpperCase() : null;
}

function normaliseTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}
