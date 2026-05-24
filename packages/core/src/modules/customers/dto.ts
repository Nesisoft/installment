import { z } from 'zod';
import { ghPhoneNumber, ghanaCardNumber, momoProviderCode } from '../../shared/validators/ghana';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const consentFlags = z
  .object({
    data_processing: z.boolean().optional(),
    credit_scoring: z.boolean().optional(),
    marketing: z.boolean().optional(),
  })
  .optional();

export const registerCustomerSchema = z.object({
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().email(),
  phone: ghPhoneNumber,
  date_of_birth: isoDate.optional(),
  consents: consentFlags,
  metadata: z.record(z.unknown()).optional(),
});
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    email: z.string().email(),
    phone: ghPhoneNumber,
    date_of_birth: isoDate,
    metadata: z.record(z.unknown()),
  })
  .partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const attachGhanaCardSchema = z.object({
  ghana_card_number: ghanaCardNumber,
  /** S3 / object-storage key where the image is already uploaded. */
  ghana_card_image_key: z.string().trim().min(1),
});
export type AttachGhanaCardInput = z.infer<typeof attachGhanaCardSchema>;

export const setMomoSchema = z.object({
  momo_phone: ghPhoneNumber,
  momo_provider: momoProviderCode,
});
export type SetMomoInput = z.infer<typeof setMomoSchema>;

export const setBlocklistSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type SetBlocklistInput = z.infer<typeof setBlocklistSchema>;

export const recordConsentSchema = z.object({
  type: z.enum(['data_processing', 'credit_scoring', 'marketing']),
});
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;
export type ConsentType = RecordConsentInput['type'];

export const listCustomersSchema = z.object({
  kyc_tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  is_on_blocklist: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListCustomersInput = z.infer<typeof listCustomersSchema>;
