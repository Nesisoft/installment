import { and, asc, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@installment/db';
import { PRODUCT_STATUSES } from './products.dto';
import { STORE_STATUSES } from '../stores/dto';
import {
  productCols,
  type Product,
  type ProductDetails,
  type ProductsService,
} from './products.service';
import type { MediaService } from './media';

const p = schema.products;
const pv = schema.product_variants;
const inv = schema.inventory;
const img = schema.product_images;
const st = schema.stores;
const merch = schema.merchants;
const cat = schema.categories;

/** `%` and `_` in a search are the characters, not patterns. */
const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export const listAdminProductsSchema = z.object({
  status: z.enum(PRODUCT_STATUSES).optional(),
  /** Only listings staff have taken down. */
  taken_down: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  store_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAdminProductsInput = z.input<typeof listAdminProductsSchema>;

export const listAdminStoresSchema = z.object({
  status: z.enum(STORE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAdminStoresInput = z.input<typeof listAdminStoresSchema>;

/** One listing in the console: the product, its shop, and what it looks like. */
export interface AdminProductRow extends Product {
  store_name: string | null;
  merchant_name: string | null;
  category_name: string | null;
  /** The first image, resolved; null when there is none or storage is unset. */
  image_url: string | null;
  variant_count: number;
  /** Sellable now, across its variants (reservations already taken out). */
  units_available: number;
}

export interface AdminProductDetail extends Omit<ProductDetails, 'images'> {
  images: (ProductDetails['images'][number] & { url: string | null })[];
  store: { id: string; display_name: string; slug: string; status: string } | null;
  merchant: { id: string; business_name: string; status: string } | null;
  category: { id: string; name: string } | null;
}

/** One shop in the console, with its seller and how much it lists. */
export interface AdminStoreRow {
  id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  status: string;
  city: string | null;
  region: string | null;
  logo_url: string | null;
  created_at: string;
  merchant_name: string | null;
  merchant_status: string | null;
  product_count: number;
  active_product_count: number;
}

export type AdminProductCounts = Record<
  (typeof PRODUCT_STATUSES)[number] | 'taken_down' | 'all',
  number
>;
export type AdminStoreCounts = Record<(typeof STORE_STATUSES)[number] | 'all', number>;

/**
 * The marketplace's catalogue, as staff moderate it: every seller's listings
 * and shops, with the names and pictures a person needs to judge them.
 *
 * The admin product and store routes could already list and change both, but
 * they answered with bare rows — store and merchant ids, image storage keys —
 * so moderating meant cross-referencing ids by hand, and there was nothing to
 * look at. Reads only; the changes go through ProductsService and
 * StoresService, which own the rules and the audit trail.
 */
export class AdminCatalogService {
  constructor(
    private readonly db: Database,
    private readonly products: Pick<ProductsService, 'getWithDetails'>,
    private readonly media: Pick<MediaService, 'url'>,
  ) {}

  async listProducts(
    rawInput: ListAdminProductsInput = {},
  ): Promise<{ rows: AdminProductRow[]; total: number }> {
    const input = listAdminProductsSchema.parse(rawInput);
    const where: SQL[] = [isNull(p.deleted_at)];
    if (input.status) where.push(eq(p.status, input.status));
    if (input.taken_down) where.push(isNotNull(p.taken_down_at));
    if (input.store_id) where.push(eq(p.store_id, input.store_id));
    if (input.category_id) where.push(eq(p.category_id, input.category_id));
    if (input.q) where.push(ilike(p.title, like(input.q)));
    const filter = and(...where);

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(p)
      .where(filter);

    const rows = await this.db
      .select({
        product: productCols,
        store_name: st.display_name,
        merchant_name: merch.business_name,
        category_name: cat.name,
        image_key: sql<string | null>`(
          SELECT ${img.storage_key} FROM ${img}
          WHERE ${img.product_id} = ${p.id}
          ORDER BY ${img.position}, ${img.id} LIMIT 1)`,
        variant_count: sql<number>`(
          SELECT count(*)::int FROM ${pv} WHERE ${pv.product_id} = ${p.id})`,
        units_available: sql<number>`(
          SELECT coalesce(sum(${inv.quantity_available}), 0)::int
          FROM ${pv} JOIN ${inv} ON ${inv.variant_id} = ${pv.id}
          WHERE ${pv.product_id} = ${p.id})`,
      })
      .from(p)
      .leftJoin(st, eq(st.id, p.store_id))
      .leftJoin(merch, eq(merch.id, p.merchant_id))
      .leftJoin(cat, eq(cat.id, p.category_id))
      .where(filter)
      .orderBy(desc(p.updated_at), desc(p.id))
      .limit(input.limit)
      .offset(input.offset);

    return {
      rows: rows.map((r) => ({
        ...r.product,
        store_name: r.store_name,
        merchant_name: r.merchant_name,
        category_name: r.category_name,
        image_url: this.media.url(r.image_key),
        variant_count: r.variant_count,
        units_available: r.units_available,
      })),
      total,
    };
  }

  async productCounts(): Promise<AdminProductCounts> {
    const [row] = await this.db
      .select({
        draft: sql<number>`count(*) FILTER (WHERE ${p.status} = 'draft')::int`,
        active: sql<number>`count(*) FILTER (WHERE ${p.status} = 'active')::int`,
        archived: sql<number>`count(*) FILTER (WHERE ${p.status} = 'archived')::int`,
        taken_down: sql<number>`count(*) FILTER (WHERE ${p.taken_down_at} IS NOT NULL)::int`,
        all: sql<number>`count(*)::int`,
      })
      .from(p)
      .where(isNull(p.deleted_at));
    return row ?? { draft: 0, active: 0, archived: 0, taken_down: 0, all: 0 };
  }

  async productDetail(id: string): Promise<AdminProductDetail> {
    const details = await this.products.getWithDetails(id);
    const [who] = await this.db
      .select({
        store: { id: st.id, display_name: st.display_name, slug: st.slug, status: st.status },
        merchant: { id: merch.id, business_name: merch.business_name, status: merch.status },
        category: { id: cat.id, name: cat.name },
      })
      .from(p)
      .leftJoin(st, eq(st.id, p.store_id))
      .leftJoin(merch, eq(merch.id, p.merchant_id))
      .leftJoin(cat, eq(cat.id, p.category_id))
      .where(eq(p.id, id))
      .limit(1);
    return {
      ...details,
      images: details.images.map((i) => ({ ...i, url: this.media.url(i.storage_key) })),
      store: who?.store?.id ? who.store : null,
      merchant: who?.merchant?.id ? who.merchant : null,
      category: who?.category?.id ? who.category : null,
    };
  }

  async listStores(
    rawInput: ListAdminStoresInput = {},
  ): Promise<{ rows: AdminStoreRow[]; total: number }> {
    const input = listAdminStoresSchema.parse(rawInput);
    const where: SQL[] = [];
    if (input.status) where.push(eq(st.status, input.status));
    if (input.q) where.push(ilike(st.display_name, like(input.q)));
    const filter = where.length ? and(...where) : undefined;

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(st)
      .where(filter);

    const rows = await this.db
      .select({
        id: st.id,
        merchant_id: st.merchant_id,
        slug: st.slug,
        display_name: st.display_name,
        status: st.status,
        city: st.city,
        region: st.region,
        logo_key: st.logo_key,
        created_at: st.created_at,
        merchant_name: merch.business_name,
        merchant_status: merch.status,
        product_count: sql<number>`(
          SELECT count(*)::int FROM ${p}
          WHERE ${p.store_id} = ${st.id} AND ${p.deleted_at} IS NULL)`,
        active_product_count: sql<number>`(
          SELECT count(*)::int FROM ${p}
          WHERE ${p.store_id} = ${st.id} AND ${p.deleted_at} IS NULL AND ${p.status} = 'active')`,
      })
      .from(st)
      .leftJoin(merch, eq(merch.id, st.merchant_id))
      .where(filter)
      // Shops waiting for a decision first, oldest of them first.
      .orderBy(sql`(${st.status} = 'draft') DESC`, asc(st.created_at), asc(st.id))
      .limit(input.limit)
      .offset(input.offset);

    return {
      rows: rows.map(({ logo_key, ...r }) => ({ ...r, logo_url: this.media.url(logo_key) })),
      total,
    };
  }

  async storeCounts(): Promise<AdminStoreCounts> {
    const [row] = await this.db
      .select({
        draft: sql<number>`count(*) FILTER (WHERE ${st.status} = 'draft')::int`,
        active: sql<number>`count(*) FILTER (WHERE ${st.status} = 'active')::int`,
        suspended: sql<number>`count(*) FILTER (WHERE ${st.status} = 'suspended')::int`,
        all: sql<number>`count(*)::int`,
      })
      .from(st);
    return row ?? { draft: 0, active: 0, suspended: 0, all: 0 };
  }
}
