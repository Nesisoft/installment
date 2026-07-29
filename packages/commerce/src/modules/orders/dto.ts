import { z } from 'zod';

// --- Addresses --------------------------------------------------------------

export const createAddressSchema = z.object({
  recipient: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(7).max(20),
  region: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(120),
  area: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(300).optional(),
  ghanapost_gps: z.string().trim().max(60).optional(),
  is_default: z.boolean().optional(),
});
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

export const updateAddressSchema = createAddressSchema.partial();
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

// --- Cart -------------------------------------------------------------------

export const addCartItemSchema = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000).default(1),
});
export type AddCartItemInput = z.infer<typeof addCartItemSchema>;

export const setCartItemQuantitySchema = z.object({
  /** 0 removes the line. */
  quantity: z.number().int().min(0).max(1000),
});
export type SetCartItemQuantityInput = z.infer<typeof setCartItemQuantitySchema>;
