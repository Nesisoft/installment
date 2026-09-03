import { z } from 'zod';
import { slugSchema } from '@installment/core';

export const STORE_STATUSES = ['draft', 'active', 'suspended'] as const;

export const createStoreSchema = z.object({
  merchant_id: z.string().uuid(),
  slug: slugSchema,
  display_name: z.string().trim().min(1).max(200),
  about: z.string().trim().max(5000).optional(),
  logo_key: z.string().trim().min(1).max(500).optional(),
  banner_key: z.string().trim().min(1).max(500).optional(),
  support_email: z.string().email().optional(),
  support_phone: z.string().trim().min(7).max(20).optional(),
  /**
   * What the shop mainly sells, as a category slug.
   *
   * A slug rather than a uuid because that is what `/storefront/categories`
   * already hands every client, and because a request body naming `electronics`
   * is readable in a log where a uuid is not. The service turns it into the
   * foreign key and refuses one that is not a real top-level category.
   */
  primary_category_slug: z.string().trim().min(1).max(120).optional(),
  policies: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateStoreInput = z.infer<typeof createStoreSchema>;

/** Everything but the immutable merchant binding is patchable. */
export const updateStoreSchema = createStoreSchema.omit({ merchant_id: true }).partial();
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

/**
 * What a merchant may change about their own shopfront. Mirrors
 * `@installment/api-types`.
 *
 * Not `slug`: it is the storefront's public URL, so a merchant renaming it
 * silently breaks every link anyone has shared, every QR code on a flyer and
 * every search result — a platform decision with an admin behind it, not a
 * settings field. Not `status` either; going live is a transition with its own
 * route and its own audit trail.
 */
export const updateMyStoreSchema = updateStoreSchema.omit({ slug: true });
export type UpdateMyStoreInput = z.infer<typeof updateMyStoreSchema>;

export const transitionStoreSchema = z.object({
  event: z.enum(['activate', 'suspend', 'unsuspend']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionStoreInput = z.infer<typeof transitionStoreSchema>;

export const listStoresSchema = z.object({
  status: z.enum(STORE_STATUSES).optional(),
  /**
   * Narrow to one merchant's shopfront.
   *
   * Added for the admin review screen: self-signup creates a `draft` store, and
   * an admin reviewing the merchant needs to see and open that exact shop. The
   * service could already answer it (`getByMerchant`) and the HTTP surface
   * could not, so the only way to activate a signed-up merchant's shop was a
   * hand-rolled request.
   */
  merchant_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListStoresInput = z.infer<typeof listStoresSchema>;
