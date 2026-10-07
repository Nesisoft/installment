import { z } from 'zod';

const BUSINESS_MODELS = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'] as const;

// Mirrors packages/core plan-templates create/update validation. Amounts are
// pesewas, rates are basis points — the editor converts from GHS/% before parse.
export const createPlanTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    business_model: z.enum(BUSINESS_MODELS),
    number_of_installments: z.number().int().min(1).max(24),
    installment_frequency_days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
    down_payment_bps: z.number().int().min(0).max(10000).default(0),
    interest_rate_bps: z.number().int().min(0).max(10000).default(0),
    service_fee_flat_pesewas: z.number().int().min(0).default(0),
    late_fee_pesewas: z.number().int().min(0).default(0),
    late_fee_bps_per_week: z.number().int().min(0).max(10000).default(0),
    late_fee_cap_bps: z.number().int().min(0).max(10000).default(0),
    grace_period_days: z.number().int().min(0).max(14).default(3),
    min_amount_pesewas: z.number().int().min(0),
    max_amount_pesewas: z.number().int().min(1),
    eligible_categories: z.array(z.string()).default([]),
    excluded_categories: z.array(z.string()).default([]),
    effective_from: z.string().datetime().optional(),
    effective_to: z.string().datetime().optional(),
  })
  .refine((v) => v.max_amount_pesewas >= v.min_amount_pesewas, {
    message: 'Max amount must be greater than or equal to min amount',
    path: ['max_amount_pesewas'],
  });
export type CreatePlanTemplateInput = z.infer<typeof createPlanTemplateSchema>;

/** Schedule-shape fields (model / count / frequency) are not updatable. */
export const updatePlanTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable(),
    interest_rate_bps: z.number().int().min(0).max(10000),
    service_fee_flat_pesewas: z.number().int().min(0),
    late_fee_pesewas: z.number().int().min(0),
    late_fee_bps_per_week: z.number().int().min(0).max(10000),
    late_fee_cap_bps: z.number().int().min(0).max(10000),
    grace_period_days: z.number().int().min(0).max(14),
    min_amount_pesewas: z.number().int().min(0),
    max_amount_pesewas: z.number().int().min(1),
    eligible_categories: z.array(z.string()),
    excluded_categories: z.array(z.string()),
    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable(),
  })
  .partial();
export type UpdatePlanTemplateInput = z.infer<typeof updatePlanTemplateSchema>;

export interface ListPlanTemplatesParams {
  business_model?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}
