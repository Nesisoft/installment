import { z } from 'zod';

// Mirrors packages/commerce/src/modules/stores/dto.ts for client-side validation.
// Browser-safe copy: this package never imports the backend packages.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(SLUG_RE, 'must be lowercase kebab-case (a-z, 0-9, hyphen-separated)');

export const createStoreSchema = z.object({
  merchant_id: z.string().uuid(),
  slug,
  display_name: z.string().trim().min(1).max(200),
  about: z.string().trim().max(5000).optional(),
  logo_key: z.string().trim().min(1).max(500).optional(),
  banner_key: z.string().trim().min(1).max(500).optional(),
  support_email: z.string().email().optional(),
  support_phone: z.string().trim().min(7).max(20).optional(),
  policies: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateStoreInput = z.infer<typeof createStoreSchema>;

export const updateStoreSchema = createStoreSchema.omit({ merchant_id: true }).partial();
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const transitionStoreSchema = z.object({
  event: z.enum(['activate', 'suspend', 'unsuspend']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionStoreInput = z.infer<typeof transitionStoreSchema>;

export interface ListStoresParams {
  status?: string;
  limit?: number;
  offset?: number;
}
