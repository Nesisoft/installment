import { z } from 'zod';

const BUSINESS_MODELS = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'] as const;
const FREQUENCIES = [7, 14, 30] as const;

/**
 * Plan template DTOs — Zod mirrors of the CHECK constraints in 0001:
 *   * 1 ≤ number_of_installments ≤ 24
 *   * installment_frequency_days ∈ {7, 14, 30}
 *   * 0 ≤ down_payment_bps ≤ 10000
 *   * 0 ≤ interest_rate_bps ≤ 10000
 *   * 0 ≤ grace_period_days ≤ 14
 *   * min_amount_pesewas ≥ 0, max_amount_pesewas > 0, max ≥ min
 *   * effective_to (when set) > effective_from
 */
export const createPlanTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    business_model: z.enum(BUSINESS_MODELS),

    number_of_installments: z.number().int().min(1).max(24),
    installment_frequency_days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
    down_payment_bps: z.number().int().min(0).max(10_000).default(0),

    interest_rate_bps: z.number().int().min(0).max(10_000).default(0),
    service_fee_flat_pesewas: z.number().int().min(0).default(0),
    late_fee_pesewas: z.number().int().min(0).default(0),
    grace_period_days: z.number().int().min(0).max(14).default(3),

    min_amount_pesewas: z.number().int().min(0),
    max_amount_pesewas: z.number().int().min(1),
    eligible_categories: z.array(z.string().min(1)).default([]),
    excluded_categories: z.array(z.string().min(1)).default([]),

    effective_from: z.string().datetime().optional(),
    effective_to: z.string().datetime().optional(),
  })
  .refine((v) => v.max_amount_pesewas >= v.min_amount_pesewas, {
    message: 'max_amount_pesewas must be >= min_amount_pesewas',
    path: ['max_amount_pesewas'],
  })
  .refine((v) => !v.effective_to || !v.effective_from || v.effective_to > v.effective_from, {
    message: 'effective_to must be after effective_from',
    path: ['effective_to'],
  });
export type CreatePlanTemplateInput = z.infer<typeof createPlanTemplateSchema>;

/**
 * Update only the fields that aren't structurally part of the schedule
 * shape — keep number_of_installments / frequency / business_model
 * immutable so an active plan can never silently move its repayment grid.
 * Re-creating a new plan template is the correct path for those changes.
 */
export const updatePlanTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable(),
    interest_rate_bps: z.number().int().min(0).max(10_000),
    service_fee_flat_pesewas: z.number().int().min(0),
    late_fee_pesewas: z.number().int().min(0),
    grace_period_days: z.number().int().min(0).max(14),
    min_amount_pesewas: z.number().int().min(0),
    max_amount_pesewas: z.number().int().min(1),
    eligible_categories: z.array(z.string().min(1)),
    excluded_categories: z.array(z.string().min(1)),
    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable(),
  })
  .partial()
  .refine(
    (v) =>
      v.min_amount_pesewas === undefined ||
      v.max_amount_pesewas === undefined ||
      v.max_amount_pesewas >= v.min_amount_pesewas,
    {
      message: 'max_amount_pesewas must be >= min_amount_pesewas',
      path: ['max_amount_pesewas'],
    },
  );
export type UpdatePlanTemplateInput = z.infer<typeof updatePlanTemplateSchema>;

export const listPlanTemplatesSchema = z.object({
  business_model: z.enum(BUSINESS_MODELS).optional(),
  is_active: z.boolean().optional(),
  /** When set, only return rows currently effective at this instant. */
  effective_at: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListPlanTemplatesInput = z.infer<typeof listPlanTemplatesSchema>;

export const PLAN_TEMPLATE_FREQUENCIES = FREQUENCIES;
export type PlanTemplateBusinessModel = (typeof BUSINESS_MODELS)[number];
