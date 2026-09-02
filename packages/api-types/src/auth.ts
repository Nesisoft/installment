import { z } from 'zod';
import type { Permission, UserType } from './enums';

// --- Request schemas (reused for client-side form validation) ---------------

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Ghana phone: accept 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX; the backend
// canonicalizes to E.164, so we validate loosely and let it normalize.
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?233|0)\d{9}$/, 'Enter a valid Ghana phone number');

export const otpStartSchema = z.object({ phone: phoneSchema });
export type OtpStartInput = z.infer<typeof otpStartSchema>;

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .length(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const signupStartSchema = z.object({ phone: phoneSchema });
export type SignupStartInput = z.infer<typeof signupStartSchema>;

/**
 * Consent is captured at signup, per purpose. Processing and credit scoring are
 * required — a BNPL account cannot exist without them — while marketing is
 * genuinely optional and must be opted into rather than out of.
 */
export const signupVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .length(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
  first_name: z.string().trim().min(1, 'Enter your first name').max(80),
  last_name: z.string().trim().min(1, 'Enter your last name').max(80),
  email: z.string().email('Enter a valid email').optional(),
  consents: z.object({
    data_processing: z.literal(true, {
      errorMap: () => ({ message: 'Please agree to how we use your data' }),
    }),
    credit_scoring: z.literal(true, {
      errorMap: () => ({ message: 'Please agree to the credit check' }),
    }),
    marketing: z.boolean().default(false),
  }),
});
export type SignupVerifyInput = z.infer<typeof signupVerifySchema>;

/** Step 2: prove the code. Returns a ticket; creates nothing. */
export const signupVerifyCodeSchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .length(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export type SignupVerifyCodeInput = z.infer<typeof signupVerifyCodeSchema>;

/**
 * Step 3: the ticket plus the profile. No phone here — it travels inside the
 * ticket, so the number that was verified is the number that gets registered.
 */
export const signupCompleteSchema = z.object({
  signupToken: z.string().min(1),
  first_name: z.string().trim().min(1, 'Enter your first name').max(80),
  last_name: z.string().trim().min(1, 'Enter your last name').max(80),
  email: z.string().email('Enter a valid email').optional(),
  consents: z.object({
    data_processing: z.literal(true, {
      errorMap: () => ({ message: 'Please agree to how we use your data' }),
    }),
    credit_scoring: z.literal(true, {
      errorMap: () => ({ message: 'Please agree to the credit check' }),
    }),
    marketing: z.boolean().default(false),
  }),
});
export type SignupCompleteInput = z.infer<typeof signupCompleteSchema>;

// --- Merchant self-signup ---------------------------------------------------
//
// Mirrors packages/core/src/modules/auth/dto.ts. Same three steps as the
// customer flow and the same OTP machinery: a Ghanaian trader has a phone, and
// this system has no email delivery. Merchants log in with email and password
// afterwards; the phone proves a person is behind the account first.

export const merchantSignupStartSchema = z.object({ phone: phoneSchema });
export type MerchantSignupStartInput = z.infer<typeof merchantSignupStartSchema>;

export const merchantSignupVerifyCodeSchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
});
export type MerchantSignupVerifyCodeInput = z.infer<typeof merchantSignupVerifyCodeSchema>;

/**
 * Note what a merchant cannot send: `default_mdr_bps`, `default_reserve_bps`
 * and `default_business_model` are the marketplace's commercial terms and come
 * from the platform defaults, and `slug` is derived server-side from the shop
 * name — letting a stranger claim one at signup is how well-known names get
 * squatted.
 */
export const merchantSignupCompleteSchema = z.object({
  signupToken: z.string().min(1),
  business_name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  tin: z.string().trim().min(1).max(60).optional(),
  registration_number: z.string().trim().min(1).max(60).optional(),
});
export type MerchantSignupCompleteInput = z.infer<typeof merchantSignupCompleteSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof refreshSchema>;

// --- Responses --------------------------------------------------------------

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  userId: string;
  userType: UserType;
  tokens: AuthTokens;
  permissions: Permission[];
}

export interface AuthenticatedUser {
  id: string;
  userType: UserType;
}

export interface OtpStartResult {
  expiresAt: string;
}
