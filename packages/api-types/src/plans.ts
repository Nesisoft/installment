import { z } from 'zod';
import type { CustomerPlan, InstallmentScheduleRow } from './domain';

export const recordManualPaymentSchema = z.object({
  provider_reference: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;

/**
 * Mirrors `refundInstallmentSchema` in core. `forgive` writes the instalment
 * off; `recollect` keeps the debt and schedules it again on `due_date`.
 */
export const REFUND_MODES = ['forgive', 'recollect'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];
export const refundInstallmentSchema = z.object({
  mode: z.enum(REFUND_MODES).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  /** `YYYY-MM-DD`; re-collect only. The server defaults it to a week out. */
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date')
    .optional(),
});
export type RefundInstallmentInput = z.infer<typeof refundInstallmentSchema>;

export const defaultPlanSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
  unrecoveredAmountPesewas: z.number().int().min(0).optional(),
});
export type DefaultPlanInput = z.infer<typeof defaultPlanSchema>;

/** Returned by POST /admin/plans/from-application/:applicationId. */
export interface ActivatedPlan {
  plan: CustomerPlan;
  schedule: InstallmentScheduleRow[];
}
