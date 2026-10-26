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
  /** Display only; charged by nothing. A negotiated rate is an `*_override`. */
  default_mdr_bps: z.number().int().min(0).max(2000).default(400),
  default_reserve_bps: z.number().int().min(0).max(5000).default(500),
  /** A negotiated rate. Absent or NULL: each plan charges its model's own rate. */
  mdr_bps_override: z.number().int().min(0).max(2000).nullable().optional(),
  reserve_bps_override: z.number().int().min(0).max(5000).nullable().optional(),
  /** A negotiated commission on paid-in-full orders. Absent or NULL: the platform default. */
  commission_bps_override: z.number().int().min(0).max(2000).nullable().optional(),
});
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

/** A partial patch; NULL on an `*_override` ends the deal. */
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
 * A merchant setting their own payout destination. Mirrors
 * `setPayoutAccountSchema` in core — note the absent `account_name`: the name
 * is read back from the bank on every write, never sent by the client.
 */
export const setPayoutAccountSchema = z.object({
  bank_code: z.string().trim().min(1).max(20),
  account_number: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{5,20}$/, 'Expected an account number of 5-20 digits')),
  /**
   * The code texted to the merchant's phone (`POST /merchant/payout-account/code`).
   * Needed to replace an account already on file; a first account needs none.
   */
  code: z.string().trim().optional(),
});
export type SetPayoutAccountInput = z.infer<typeof setPayoutAccountSchema>;
export const resolvePayoutAccountSchema = setPayoutAccountSchema.omit({ code: true });
export type ResolvePayoutAccountInput = z.infer<typeof resolvePayoutAccountSchema>;

/** Where the change code went, masked, and when it stops working. */
export interface PayoutChangeCodeSent {
  sent_to: string;
  expires_at: string;
}

export interface PayoutDestination {
  code: string;
  name: string;
  kind: 'bank' | 'mobile_money';
}

export interface PayoutAccountView {
  connected: boolean;
  bank_code: string | null;
  account_number_masked: string | null;
  account_name: string | null;
  /**
   * ISO time before which settlement will not pay this account — it replaced
   * another one within the last day. Null when nothing is held.
   */
  payouts_held_until: string | null;
  /**
   * Whether saving an account needs the code texted to the seller's phone:
   * one is already on file, or money is already owed. Ask for the code when
   * true, rather than only when `connected`.
   */
  code_required: boolean;
}

export interface ResolvedPayoutAccount {
  account_name: string;
  account_number: string;
  bank_code: string;
}

// --- KYC -------------------------------------------------------------------

export const MERCHANT_KYC_DOC_TYPES = [
  'ghana_card_front',
  'ghana_card_back',
  'shop_photo',
  'business_registration',
] as const;
export type MerchantKycDocType = (typeof MERCHANT_KYC_DOC_TYPES)[number];

export interface MerchantKycDocument {
  id: string;
  merchant_id: string;
  doc_type: MerchantKycDocType;
  storage_key: string;
  status: 'submitted' | 'approved' | 'rejected';
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface MerchantKycStatus {
  documents: MerchantKycDocument[];
  /** Required types with no approved document yet. Empty means ready to review. */
  outstanding: MerchantKycDocType[];
  complete: boolean;
  /** Activated before document review existed; the gate lets them keep trading. */
  exempt: boolean;
}

/** Mirrors `submitKycDocumentSchema` in core. */
export const submitKycDocumentSchema = z.object({
  doc_type: z.enum(MERCHANT_KYC_DOC_TYPES),
  storage_key: z.string().trim().min(1),
});
export type SubmitKycDocumentInput = z.infer<typeof submitKycDocumentSchema>;

export const rejectKycDocumentSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectKycDocumentInput = z.infer<typeof rejectKycDocumentSchema>;

export interface ListMerchantsParams {
  status?: string;
  limit?: number;
  offset?: number;
}
