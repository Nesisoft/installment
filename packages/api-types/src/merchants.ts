import { z } from 'zod';

const BUSINESS_MODELS = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'] as const;

// Mirrors packages/core/src/modules/merchants/dto.ts for client-side validation.
export const createMerchantSchema = z.object({
  business_name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().min(1).max(200),
  email: z.string().email(),
  phone: z.string().trim().min(7).max(20),
  tin: z.string().trim().min(1).optional(),
  registration_number: z.string().trim().min(1).optional(),
  default_business_model: z.enum(BUSINESS_MODELS).default('bnpl'),
  default_mdr_bps: z.number().int().min(0).max(2000).default(400),
  default_reserve_bps: z.number().int().min(0).max(5000).default(500),
});
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

export const transitionMerchantSchema = z.object({
  event: z.enum(['activate', 'suspend', 'reactivate', 'offboard']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionMerchantInput = z.infer<typeof transitionMerchantSchema>;

export const attachPaystackRecipientSchema = z.object({
  paystack_recipient_code: z.string().trim().min(1),
  bank_account_number: z.string().trim().min(1).optional(),
  bank_code: z.string().trim().min(1).optional(),
  bank_account_name: z.string().trim().min(1).optional(),
});
export type AttachPaystackRecipientInput = z.infer<typeof attachPaystackRecipientSchema>;

export interface ListMerchantsParams {
  status?: string;
  limit?: number;
  offset?: number;
}
