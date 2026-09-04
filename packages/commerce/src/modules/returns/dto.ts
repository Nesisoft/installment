import { z } from 'zod';

export const REQUEST_RETURN_REASON_MAX = 1_000;

export const requestReturnSchema = z.object({
  /**
   * Required, and not from a fixed list. A seller decides on the reason, and
   * "wrong size" versus "arrived with the screen cracked" are different
   * decisions — a dropdown would flatten exactly the information the decision
   * turns on.
   */
  reason: z.string().trim().min(1).max(REQUEST_RETURN_REASON_MAX),
});
export type RequestReturnInput = z.infer<typeof requestReturnSchema>;

export const rejectReturnSchema = z.object({
  /** Shown to the buyer. A refusal with no reason is not something to act on. */
  decision_note: z.string().trim().min(1).max(REQUEST_RETURN_REASON_MAX),
});
export type RejectReturnInput = z.infer<typeof rejectReturnSchema>;

export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const listReturnsSchema = z.object({
  status: z.enum(RETURN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;
