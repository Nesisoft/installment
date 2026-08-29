import { z } from 'zod';

// Mirrors packages/commerce/src/modules/orders/dto.ts for client-side
// validation. Browser-safe copy: no backend imports.

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
  quantity: z.number().int().min(0).max(1000),
});
export type SetCartItemQuantityInput = z.infer<typeof setCartItemQuantitySchema>;

// --- Checkout ---------------------------------------------------------------

export const checkoutSchema = z
  .object({
    payment_type: z.enum(['full', 'installment']),
    shipping_address_id: z.string().uuid().optional(),
    plan_template_id: z.string().uuid().optional(),
  })
  .refine((v) => v.payment_type !== 'installment' || !!v.plan_template_id, {
    message: 'installment checkout requires plan_template_id',
    path: ['plan_template_id'],
  });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// --- Fulfilment -------------------------------------------------------------
//
// Mirrors packages/commerce/src/modules/fulfilment/dto.ts. Everything is
// optional there and optional here for the same reason: a seller handing a
// parcel to a rider often knows nothing but "it has gone", and demanding a
// tracking code they do not have either blocks the update or invites a made-up
// one.

export const markShippedSchema = z.object({
  courier_name: z.string().trim().max(120).optional(),
  courier_phone: z.string().trim().max(20).optional(),
  rider_name: z.string().trim().max(120).optional(),
  tracking_code: z.string().trim().max(120).optional(),
  eta_at: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(300).optional(),
});
export type MarkShippedInput = z.infer<typeof markShippedSchema>;

export const markOutForDeliverySchema = z.object({
  rider_name: z.string().trim().max(120).optional(),
  courier_phone: z.string().trim().max(20).optional(),
  eta_at: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(300).optional(),
});
export type MarkOutForDeliveryInput = z.infer<typeof markOutForDeliverySchema>;

export const markDeliveredSchema = z.object({
  delivered_at: z.string().datetime({ offset: true }).optional(),
  received_by: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});
export type MarkDeliveredInput = z.infer<typeof markDeliveredSchema>;
