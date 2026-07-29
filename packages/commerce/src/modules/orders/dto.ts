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

// --- Checkout ---------------------------------------------------------------

export const checkoutSchema = z
  .object({
    /** `full` = pay now; `installment` = finance through the engine. */
    payment_type: z.enum(['full', 'installment']),
    /** Optional saved shipping address; must belong to the customer. */
    shipping_address_id: z.string().uuid().optional(),
    /** Required for installment checkout — the plan the application is scored against. */
    plan_template_id: z.string().uuid().optional(),
  })
  .refine((v) => v.payment_type !== 'installment' || !!v.plan_template_id, {
    message: 'installment checkout requires plan_template_id',
    path: ['plan_template_id'],
  });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Provider confirmation that a full order's charge cleared (webhook / admin). */
export const confirmOrderPaymentSchema = z.object({
  provider_reference: z.string().trim().min(1).max(200),
});
export type ConfirmOrderPaymentInput = z.infer<typeof confirmOrderPaymentSchema>;
