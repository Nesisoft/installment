import { z } from 'zod';

/**
 * Shopper-facing read DTOs. Separate from products.dto.ts on purpose: those
 * describe what a merchant may write, these describe what a browser may ask
 * for, and the two drift apart (a shopper can sort by rating; a merchant can
 * filter by draft status).
 */

const pesewas = z.coerce.number().int().min(0);
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Sort orders offered by the filter sheet. `popular` is the default and means
 * "most sold, then newest" — a marketplace with no sales history still has to
 * put something sensible first.
 */
export const PRODUCT_SORTS = ['popular', 'price_asc', 'price_desc', 'rating', 'newest'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const browseProductsSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    category_id: z.string().uuid().optional(),
    category_slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    store_id: z.string().uuid().optional(),
    store_slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    sort: z.enum(PRODUCT_SORTS).default('popular'),
    min_price_pesewas: pesewas.optional(),
    max_price_pesewas: pesewas.optional(),
    /** Only products carrying at least one active installment offer. */
    installment_only: bool.optional(),
    /** Only products with at least one variant that has sellable stock. */
    in_stock: bool.optional(),
    /** Only products currently inside a deal window. */
    deals_only: bool.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(
    (v) =>
      v.min_price_pesewas === undefined ||
      v.max_price_pesewas === undefined ||
      v.min_price_pesewas <= v.max_price_pesewas,
    { message: 'min_price_pesewas must not exceed max_price_pesewas', path: ['min_price_pesewas'] },
  );
export type BrowseProductsInput = z.infer<typeof browseProductsSchema>;

export const homeFeedSchema = z.object({
  city: z.string().trim().max(120).optional(),
});
export type HomeFeedInput = z.infer<typeof homeFeedSchema>;

export const trendingSchema = z.object({
  city: z.string().trim().max(120).optional(),
  /** Rolling window the counts are taken over. */
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type TrendingInput = z.infer<typeof trendingSchema>;

export const listReviewsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListReviewsInput = z.infer<typeof listReviewsSchema>;

export const createReviewSchema = z.object({
  order_item_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().max(4000).optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const deliveryQuoteSchema = z.object({
  region: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  /** Quote for an existing address instead of a free-typed place. */
  address_id: z.string().uuid().optional(),
});
export type DeliveryQuoteInput = z.infer<typeof deliveryQuoteSchema>;

export const listPickupHubsSchema = z.object({
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListPickupHubsInput = z.infer<typeof listPickupHubsSchema>;
