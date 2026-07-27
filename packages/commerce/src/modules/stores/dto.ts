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
  policies: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateStoreInput = z.infer<typeof createStoreSchema>;

/** Everything but the immutable merchant binding is patchable. */
export const updateStoreSchema = createStoreSchema.omit({ merchant_id: true }).partial();
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const transitionStoreSchema = z.object({
  event: z.enum(['activate', 'suspend', 'unsuspend']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionStoreInput = z.infer<typeof transitionStoreSchema>;

export const listStoresSchema = z.object({
  status: z.enum(STORE_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListStoresInput = z.infer<typeof listStoresSchema>;
