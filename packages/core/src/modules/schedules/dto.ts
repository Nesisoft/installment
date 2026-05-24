import { z } from 'zod';

/**
 * Recording an out-of-band payment against an installment. The amount is the
 * installment's full due (admin override marks the whole installment paid);
 * an optional provider reference and reason are kept for the audit trail.
 */
export const recordManualPaymentSchema = z.object({
  provider_reference: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;
