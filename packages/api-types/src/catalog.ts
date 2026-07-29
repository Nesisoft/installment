import { z } from 'zod';

// Mirrors packages/commerce/src/modules/catalog/dto.ts and products.dto.ts for
// client-side validation. Browser-safe copy: no backend imports.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(SLUG_RE, 'must be lowercase kebab-case (a-z, 0-9, hyphen-separated)');

const pesewas = z.number().int().min(0);

// --- Categories -------------------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug,
  parent_id: z.string().uuid().optional(),
  position: z.number().int().min(0).max(1_000_000).default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slug.optional(),
  parent_id: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  is_active: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export interface ListCategoriesParams {
  parent_id?: string;
  top_level?: boolean;
  active_only?: boolean;
  limit?: number;
  offset?: number;
}

// --- Products (with nested variants / images / plan offers) ------------------

export const variantInputSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  option_values: z.record(z.unknown()).optional(),
  price_pesewas: pesewas.nullable().optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
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
  status: z.enum(['draft', 'active', 'archived']).optional(),
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
  status: z.enum(['draft', 'active', 'archived']).optional(),
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

export interface ListProductsParams {
  store_id?: string;
  merchant_id?: string;
  category_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface SearchProductsParams {
  q: string;
  limit?: number;
  offset?: number;
}

// --- Inventory --------------------------------------------------------------

export const setStockSchema = z.object({
  quantity_available: z.number().int().min(0),
  restock_threshold: z.number().int().min(0).optional(),
});
export type SetStockInput = z.infer<typeof setStockSchema>;

export const adjustStockSchema = z.object({
  delta: z.number().int(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
