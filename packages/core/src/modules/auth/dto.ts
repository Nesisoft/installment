import { z } from 'zod';
import { ghPhoneNumber } from '../../shared/validators/ghana';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const otpStartSchema = z.object({
  phone: ghPhoneNumber,
});
export type OtpStartInput = z.infer<typeof otpStartSchema>;

export const otpVerifySchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Step 1 of self-signup: prove the phone is reachable before anything is created. */
export const signupStartSchema = z.object({
  phone: ghPhoneNumber,
});
export type SignupStartInput = z.infer<typeof signupStartSchema>;

/**
 * Step 2: the code, plus the profile to create.
 *
 * Consent is captured here because this is the moment the person agrees, and
 * Ghana's Data Protection Act wants each purpose consented to separately rather
 * than bundled into one "I accept". Processing and credit scoring are required
 * — a BNPL account cannot exist without them, so refusing means not signing up,
 * not signing up without them. Marketing is genuinely optional and defaults off.
 */
/**
 * Step 2 of self-signup: prove the code, before the registration form is shown.
 * Nothing is created here — it returns a short-lived ticket for step 3.
 */
export const signupVerifyCodeSchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
});
export type SignupVerifyCodeInput = z.infer<typeof signupVerifyCodeSchema>;

/** Step 3: the ticket from step 2, plus the profile. This is what creates the account. */
export const signupCompleteSchema = z.object({
  signupToken: z.string().min(1),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().email().optional(),
  consents: z.object({
    data_processing: z.literal(true, {
      errorMap: () => ({ message: 'Consent to data processing is required to open an account' }),
    }),
    credit_scoring: z.literal(true, {
      errorMap: () => ({ message: 'Consent to credit checks is required to pay in instalments' }),
    }),
    marketing: z.boolean().default(false),
  }),
});
export type SignupCompleteInput = z.infer<typeof signupCompleteSchema>;

export const signupVerifySchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().email().optional(),
  consents: z.object({
    data_processing: z.literal(true, {
      errorMap: () => ({ message: 'Consent to data processing is required to open an account' }),
    }),
    credit_scoring: z.literal(true, {
      errorMap: () => ({ message: 'Consent to credit checks is required to pay in instalments' }),
    }),
    marketing: z.boolean().default(false),
  }),
});
export type SignupVerifyInput = z.infer<typeof signupVerifySchema>;
