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
  status: z.enum(PRODUCT_STATUSES).optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

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
