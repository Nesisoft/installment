import { z } from 'zod';

// Mirrors packages/core/src/modules/applications/dto.ts recordDecisionSchema so
// the admin decision form validates client-side against the same contract.
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
    {
      message: 'A counter-offer needs both the down-payment and financed amounts',
      path: ['counter_down_payment_pesewas'],
    },
  );
export type RecordDecisionInput = z.infer<typeof recordDecisionSchema>;

export interface ListApplicationsParams {
  status?: string;
  customer_id?: string;
  merchant_id?: string;
  limit?: number;
  offset?: number;
}
