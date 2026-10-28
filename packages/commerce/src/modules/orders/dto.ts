import { z } from 'zod';
import { ORDER_STATUSES } from './order-state';

// --- Addresses --------------------------------------------------------------

/**
 * A delivery address.
 *
 * The three free-text extras are `.nullish()`, not `.optional()`, and that one
 * word was a live checkout blocker. The columns are nullable, the `Address`
 * type the clients hold declares them `string | null`, and the shopper app's
 * address sheet accordingly sends `area: null, landmark: null,
 * ghanapost_gps: null` for a form the shopper left blank. Under `.optional()`
 * Zod refuses null outright — "Expected string, received null" — so **every**
 * attempt to save an address from the mobile app answered 400, and a shopper
 * with no address on file could not complete a courier checkout at all. The
 * web form only escaped it by spreading its optional fields conditionally.
 *
 * Accepting both is the honest contract: a field the customer left empty is
 * absent or null depending on which client is asking, and neither is a
 * mistake worth a validation error. `create` normalises them to null on the
 * way into the column.
 */
export const createAddressSchema = z.object({
  recipient: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(7).max(20),
  region: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(120),
  area: z.string().trim().max(200).nullish(),
  landmark: z.string().trim().max(300).nullish(),
  ghanapost_gps: z.string().trim().max(60).nullish(),
  is_default: z.boolean().optional(),
});
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

/**
 * Patching an address. Every field, all optional — but not NO field.
 *
 * `.partial()` on its own accepts `{}`, which reaches Drizzle's `mapUpdateSet`
 * with nothing to set and throws a bare `Error('No values to set')`. That name
 * is in neither the exception filter's status map nor its intentionally-
 * unmapped list, so a client sending an empty patch got a 500 and raised a
 * Sentry alert — a caller's mistake reported as our fault.
 */
/**
 * The delivery address as an order remembers it.
 *
 * Written once at checkout into `orders.delivery_address` and never updated:
 * where a parcel went is a fact about that order, not a view of whatever the
 * shopper's address book says today. See migration 0022.
 */
export interface DeliverySnapshot {
  recipient: string;
  phone: string;
  region: string;
  city: string;
  area: string | null;
  landmark: string | null;
  ghanapost_gps: string | null;
}

export const updateAddressSchema = createAddressSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Nothing to change',
  });
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
    /**
     * How the customer takes delivery. Courier is priced from `delivery_zones`
     * against the shipping address; pickup at a hub is free.
     */
    fulfilment_method: z.enum(['courier', 'pickup']).default('courier'),
    /** Required for pickup — which hub to collect from. */
    pickup_hub_id: z.string().uuid().optional(),
  })
  .refine((v) => v.payment_type !== 'installment' || !!v.plan_template_id, {
    message: 'installment checkout requires plan_template_id',
    path: ['plan_template_id'],
  })
  .refine((v) => v.fulfilment_method !== 'pickup' || !!v.pickup_hub_id, {
    message: 'pickup checkout requires pickup_hub_id',
    path: ['pickup_hub_id'],
  });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Provider confirmation that a full order's charge cleared (webhook / admin). */
/** Why the order was cancelled — free text, kept for the audit trail. */
export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const confirmOrderPaymentSchema = z.object({
  provider_reference: z.string().trim().min(1).max(200),
});
export type ConfirmOrderPaymentInput = z.infer<typeof confirmOrderPaymentSchema>;

// --- Admin order list -------------------------------------------------------

/** Query for GET /admin/orders. Strings off the URL, coerced. */
export const listAdminOrdersSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  payment_type: z.enum(['full', 'installment']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListAdminOrdersQuery = z.infer<typeof listAdminOrdersSchema>;
