import { z } from 'zod';
import type { CustomerPlan, InstallmentScheduleRow } from './domain';

export const recordManualPaymentSchema = z.object({
  provider_reference: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;

export const refundInstallmentSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
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
