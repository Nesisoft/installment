import { z } from 'zod';
import { slugSchema } from '../../shared/validators/slug';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
  parent_id: z.string().uuid().optional(),
  position: z.number().int().min(0).max(1_000_000).default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  parent_id: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  is_active: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listCategoriesSchema = z.object({
  /** Filter to direct children of this category id. */
  parent_id: z.string().uuid().optional(),
  /** Only top-level categories (parent_id IS NULL). Ignored if parent_id set. */
  top_level: z.boolean().optional(),
  active_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});
export type ListCategoriesInput = z.infer<typeof listCategoriesSchema>;
