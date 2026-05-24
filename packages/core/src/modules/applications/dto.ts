import { z } from 'zod';

const uuid = z.string().uuid();

export const submitApplicationSchema = z.object({
  customer_id: uuid,
  merchant_id: uuid,
  plan_template_id: uuid,
  order_reference: z.string().trim().min(1).max(120),
  order_amount_pesewas: z.number().int().positive(),
  merchant_category: z.string().trim().min(1).max(80),
  /** Optional override; defaults to the DB-level NOW() + 24h. */
  expires_at: z.string().datetime().optional(),
});
export type SubmitApplicationInput = z.infer<typeof submitApplicationSchema>;

export const listApplicationsSchema = z.object({
  customer_id: uuid.optional(),
  merchant_id: uuid.optional(),
  status: z
    .enum([
      'pending',
      'approved',
      'declined',
      'counter_offered',
      'manual_review',
      'expired',
      'cancelled',
    ])
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListApplicationsInput = z.infer<typeof listApplicationsSchema>;

/**
 * The outcome the scoring engine produced, mapped onto the application by
 * ApplicationsService.recordDecision. `approved` / `approved_tier_2` →
 * approved; `counter_offer` requires the counter amounts; `declined` should
 * carry a reason; `manual_review` parks it for an agent.
 */
export const recordDecisionSchema = z
  .object({
    outcome: z.enum(['approved', 'approved_tier_2', 'counter_offer', 'manual_review', 'declined']),
    declined_reason: z.string().trim().min(1).max(500).optional(),
    counter_down_payment_pesewas: z.number().int().min(0).optional(),
    counter_financed_pesewas: z.number().int().min(0).optional(),
  })
  .refine(
    (v) =>
      v.outcome !== 'counter_offer' ||
      (v.counter_down_payment_pesewas !== undefined && v.counter_financed_pesewas !== undefined),
    { message: 'counter_offer requires counter_down_payment_pesewas and counter_financed_pesewas' },
  );
export type RecordDecisionInput = z.infer<typeof recordDecisionSchema>;
