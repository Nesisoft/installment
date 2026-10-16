import { z } from 'zod';
import type { schema } from '@installment/db';

/**
 * The terms a customer applied under — copied from the plan template when the
 * application is submitted, and the only terms activation reads.
 *
 * The template's money terms are editable on a live template, so reading them
 * at activation priced an application by whatever the template said when it
 * was approved, not what the customer was quoted. See migration 0024.
 *
 * Validated on the way out as well as in: a JSONB column is only as typed as
 * the code that reads it, and a malformed contract must stop an activation,
 * not price one.
 */
export const planTermsSchema = z.object({
  business_model: z.enum(['bnpl', 'layaway', 'hybrid', 'rent_to_own']),
  number_of_installments: z.number().int().min(1).max(24),
  installment_frequency_days: z.number().int().positive(),
  down_payment_bps: z.number().int().min(0).max(10_000),
  interest_rate_bps: z.number().int().min(0).max(10_000),
  service_fee_flat_pesewas: z.number().int().min(0),
  grace_period_days: z.number().int().min(0).max(14),
  late_fee_bps_per_week: z.number().int().min(0).max(10_000),
  late_fee_cap_bps: z.number().int().min(0).max(10_000),
});
export type PlanTerms = z.infer<typeof planTermsSchema>;

/** The terms of `template`, as an application locks them. */
export function termsOf(template: typeof schema.plan_templates.$inferSelect): PlanTerms {
  return planTermsSchema.parse({
    business_model: template.business_model,
    number_of_installments: template.number_of_installments,
    installment_frequency_days: template.installment_frequency_days,
    down_payment_bps: template.down_payment_bps,
    interest_rate_bps: template.interest_rate_bps,
    service_fee_flat_pesewas: template.service_fee_flat_pesewas,
    grace_period_days: template.grace_period_days,
    late_fee_bps_per_week: template.late_fee_bps_per_week,
    late_fee_cap_bps: template.late_fee_cap_bps,
  });
}
