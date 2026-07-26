import { z } from 'zod';
import { phoneSchema } from './auth';

// Mirrors packages/core/src/modules/customers/dto.ts. Phone validated loosely
// (the backend canonicalizes to Ghana E.164); Ghana Card format is the standard
// GHA-XXXXXXXXX-X pattern.
export const registerCustomerSchema = z.object({
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().email(),
  phone: phoneSchema,
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .optional(),
  consents: z
    .object({
      data_processing: z.boolean().optional(),
      credit_scoring: z.boolean().optional(),
      marketing: z.boolean().optional(),
    })
    .optional(),
});
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    email: z.string().email(),
    phone: phoneSchema,
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  })
  .partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const attachGhanaCardSchema = z.object({
  ghana_card_number: z
    .string()
    .trim()
    .regex(/^GHA-\d{9}-\d$/, 'Expected GHA-XXXXXXXXX-X'),
  ghana_card_image_key: z.string().trim().min(1),
});
export type AttachGhanaCardInput = z.infer<typeof attachGhanaCardSchema>;

export const setMomoSchema = z.object({
  momo_phone: phoneSchema,
  momo_provider: z.enum(['mtn', 'tgo', 'vod']),
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

export interface ListCustomersParams {
  kyc_tier?: number;
  is_on_blocklist?: boolean;
  limit?: number;
  offset?: number;
}
