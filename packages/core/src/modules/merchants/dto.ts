import { z } from 'zod';

const BUSINESS_MODELS = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'] as const;

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
  metadata: z.record(z.unknown()).optional(),
});
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

export const updateMerchantSchema = createMerchantSchema.partial();
export type UpdateMerchantInput = z.infer<typeof updateMerchantSchema>;

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

/**
 * Ghanaian account numbers are not one shape: a GhIPSS bank account runs to
 * about sixteen digits and a mobile-money wallet is a ten-digit phone number.
 * Spaces and dashes are how people write both, so strip them rather than
 * bounce the entry.
 */
const payoutAccountNumber = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{5,20}$/, 'expected an account number of 5-20 digits'));

const bankCode = z.string().trim().min(1).max(20);

export const resolvePayoutAccountSchema = z.object({
  bank_code: bankCode,
  account_number: payoutAccountNumber,
});
export type ResolvePayoutAccountInput = z.infer<typeof resolvePayoutAccountSchema>;

/**
 * No `account_name`: it is read back from the bank on every write, never taken
 * from the caller. Accepting a name would let one be typed over an account
 * belonging to somebody else.
 */
export const setPayoutAccountSchema = resolvePayoutAccountSchema;
export type SetPayoutAccountInput = z.infer<typeof setPayoutAccountSchema>;

export const MERCHANT_KYC_DOC_TYPE_VALUES = [
  'ghana_card_front',
  'ghana_card_back',
  'shop_photo',
  'business_registration',
] as const;

export const submitKycDocumentSchema = z.object({
  doc_type: z.enum(MERCHANT_KYC_DOC_TYPE_VALUES),
  /**
   * The key the presigned-upload flow minted. Checked against the caller's own
   * `private/merchant-kyc/<merchant_id>/` prefix at the edge before it reaches
   * this service — a client-supplied key is a client-supplied victim.
   */
  storage_key: z.string().trim().min(1),
});
export type SubmitKycDocumentInput = z.infer<typeof submitKycDocumentSchema>;

export const rejectKycDocumentSchema = z.object({
  /** Read by the next reviewer, and by the merchant, who has to know what to send instead. */
  reason: z.string().trim().min(1).max(500),
});
export type RejectKycDocumentInput = z.infer<typeof rejectKycDocumentSchema>;

export const listMerchantsSchema = z.object({
  status: z.enum(['pending_kyc', 'active', 'suspended', 'offboarded']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListMerchantsInput = z.infer<typeof listMerchantsSchema>;
