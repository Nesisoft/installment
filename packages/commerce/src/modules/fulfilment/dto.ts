import { z } from 'zod';

/**
 * Fulfilment writes.
 *
 * Everything optional here is genuinely optional: a merchant handing a parcel to
 * a rider often knows nothing but "it has gone", and forcing a tracking code
 * they do not have would either block the update or invite a fake one.
 */

export const markShippedSchema = z.object({
  courier_name: z.string().trim().max(120).optional(),
  courier_phone: z.string().trim().max(20).optional(),
  rider_name: z.string().trim().max(120).optional(),
  tracking_code: z.string().trim().max(120).optional(),
  /** When the courier is expected to arrive; drives the "arriving by" line. */
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
  /** Defaults to now. Backdating is allowed — the return window counts from it. */
  delivered_at: z.string().datetime({ offset: true }).optional(),
  /** Who took the parcel, for a doorstep handover. */
  received_by: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});
export type MarkDeliveredInput = z.infer<typeof markDeliveredSchema>;
