import { z } from 'zod';

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;

const pesewas = z.number().int().min(0);

export const variantInputSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  option_values: z.record(z.unknown()).optional(),
  price_pesewas: pesewas.nullable().optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  /** Initial on-hand stock for this variant's inventory row. */
  quantity_available: z.number().int().min(0).optional(),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

export const imageInputSchema = z.object({
  storage_key: z.string().trim().min(1).max(500),
  alt_text: z.string().trim().max(300).optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
});
export type ImageInput = z.infer<typeof imageInputSchema>;

export const createProductSchema = z.object({
  store_id: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20_000).optional(),
  category_id: z.string().uuid().optional(),
  base_price_pesewas: pesewas,
  /**
   * The "was" price a discount is measured against.
   *
   * `products_compare_at_above_price` refuses anything that is not strictly
   * higher than `base_price_pesewas`, and the migration that added it says why:
   * "A strikethrough that is not actually a discount is a lie the UI would tell
   * on every card, so the database refuses it." The DTO agrees with the CHECK
   * rather than restating a looser version of it — a mismatch here is a 500
   * from a constraint violation where a 400 was owed.
   *
   * Nullable so a seller can end a sale and go back to one price.
   */
  compare_at_price_pesewas: pesewas.nullable().optional(),
  /**
   * When the sale ends, which is what the home screen counts down to.
   *
   * `products_deal_needs_compare_at` refuses one without a "was" price: a
   * countdown next to an unchanged price is a countdown to nothing.
   *
   * A date already past is accepted and simply means the deal is over — that is
   * what `deal_ends_at > NOW()` already decides on the read side, and refusing
   * it here would block a seller editing the title of a product whose sale
   * ended last week.
   */
  deal_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  attributes: z.record(z.unknown()).optional(),
  variants: z.array(variantInputSchema).max(100).optional(),
  images: z.array(imageInputSchema).max(50).optional(),
  plan_template_ids: z.array(z.string().uuid()).max(50).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  base_price_pesewas: pesewas.optional(),
  /**
   * The "was" price a discount is measured against.
   *
   * `products_compare_at_above_price` refuses anything that is not strictly
   * higher than `base_price_pesewas`, and the migration that added it says why:
   * "A strikethrough that is not actually a discount is a lie the UI would tell
   * on every card, so the database refuses it." The DTO agrees with the CHECK
   * rather than restating a looser version of it — a mismatch here is a 500
   * from a constraint violation where a 400 was owed.
   *
   * Nullable so a seller can end a sale and go back to one price.
   */
  compare_at_price_pesewas: pesewas.nullable().optional(),
  /**
   * When the sale ends, which is what the home screen counts down to.
   *
   * `products_deal_needs_compare_at` refuses one without a "was" price: a
   * countdown next to an unchanged price is a countdown to nothing.
   *
   * A date already past is accepted and simply means the deal is over — that is
   * what `deal_ends_at > NOW()` already decides on the read side, and refusing
   * it here would block a seller editing the title of a product whose sale
   * ended last week.
   */
  deal_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/**
 * The two rules `products` enforces about a sale, checked before Postgres does.
 *
 * Shared by both schemas and applied again in the service, because neither
 * schema can see the whole picture on its own: a PATCH that raises
 * `base_price_pesewas` past an untouched `compare_at_price_pesewas` is a valid
 * patch and an invalid row, and only the service holds both halves.
 */
export function dealRuleIssue(row: {
  base_price_pesewas?: number | null;
  compare_at_price_pesewas?: number | null;
  deal_ends_at?: string | null;
}): string | null {
  const { base_price_pesewas: base, compare_at_price_pesewas: compare } = row;
  if (compare != null && base != null && compare <= base) {
    return 'The “was” price has to be higher than the price you are selling at';
  }
  if (row.deal_ends_at != null && compare == null) {
    return 'A sale that ends needs a “was” price to count down from';
  }
  return null;
}

export const addVariantSchema = variantInputSchema;
export type AddVariantInput = z.infer<typeof addVariantSchema>;

export const addImageSchema = imageInputSchema;
export type AddImageInput = z.infer<typeof addImageSchema>;

export const setPlanOffersSchema = z.object({
  plan_template_ids: z.array(z.string().uuid()).max(50),
});
export type SetPlanOffersInput = z.infer<typeof setPlanOffersSchema>;

export const listProductsSchema = z.object({
  store_id: z.string().uuid().optional(),
  merchant_id: z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  /**
   * Only products with at least one active variant a customer cannot buy.
   *
   * A filter and not a status: "needs restock" is a fact about inventory, not
   * about the product row, and the seller's catalogue tab treats it as a
   * sibling of Live because that is how they think about it. Deriving it in the
   * client would need every variant of every product on the page.
   */
  needs_restock: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;

export const searchProductsSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});
export type SearchProductsInput = z.infer<typeof searchProductsSchema>;

// --- inventory -------------------------------------------------------------

export const setStockSchema = z.object({
  quantity_available: z.number().int().min(0),
  restock_threshold: z.number().int().min(0).optional(),
});
export type SetStockInput = z.infer<typeof setStockSchema>;

export const adjustStockSchema = z.object({
  /** Signed change applied to quantity_available (must not drive it negative). */
  delta: z.number().int(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
