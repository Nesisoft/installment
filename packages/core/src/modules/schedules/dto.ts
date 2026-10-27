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

/**
 * What a refund of a paid instalment means. Both send the money back; they
 * differ in what happens to the debt.
 *
 * - `forgive` (the default): the instalment is written off. The customer does
 *   not owe it again, the seller gives back what they were credited for it,
 *   and the plan can still complete. A cancellation or a return.
 * - `recollect`: the customer still owes it. The money goes back and a new
 *   instalment for the same amount is scheduled for `due_date`. A charge taken
 *   from the wrong account.
 *
 * There used to be only one refund, and it was neither: it sent the money back
 * and put the debt back on the plan with no instalment left to collect it, so
 * the plan could never complete.
 */
export const REFUND_MODES = ['forgive', 'recollect'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export const refundInstallmentSchema = z
  .object({
    mode: z.enum(REFUND_MODES).default('forgive'),
    reason: z.string().trim().min(1).max(500).optional(),
    /** `YYYY-MM-DD`; re-collect only. Defaults to seven days from now. */
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
      .optional(),
  })
  .refine((v) => v.mode === 'recollect' || v.due_date === undefined, {
    message: 'due_date only applies to mode "recollect"',
    path: ['due_date'],
  });
export type RefundInstallmentInput = z.infer<typeof refundInstallmentSchema>;
