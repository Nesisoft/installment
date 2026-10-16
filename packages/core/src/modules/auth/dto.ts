import { z } from 'zod';
import { adultDateOfBirth } from '../../shared/validators/date-of-birth';
import {
  ghPhoneNumber,
  ghanaCity,
  ghanaRegion,
  momoProviderCode,
} from '../../shared/validators/ghana';

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
  /**
   * Required, and the reason is a hard gate: `gate.age_range` declines an
   * application whose age it does not know, and `customers.date_of_birth` is
   * the only thing that age is derived from. An account opened without one
   * cannot be approved for instalments at all — which is what this product is.
   */
  date_of_birth: adultDateOfBirth,
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

// --- Merchant self-signup ---------------------------------------------------
//
// Same three steps as the customer flow and the same OTP machinery, because a
// Ghanaian trader has a phone and email delivery does not exist in this system
// yet. Merchants log in with email and password afterwards; the phone is what
// proves the account is a person before any row is written.

export const merchantSignupStartSchema = z.object({
  phone: ghPhoneNumber,
});
export type MerchantSignupStartInput = z.infer<typeof merchantSignupStartSchema>;

export const merchantSignupVerifyCodeSchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
});
export type MerchantSignupVerifyCodeInput = z.infer<typeof merchantSignupVerifyCodeSchema>;

/**
 * Step 3: the ticket from step 2, plus the business. This is what creates the
 * merchant, its login and its shopfront.
 *
 * Note what is NOT here, and cannot be: `mdr_bps_override`,
 * `reserve_bps_override` (the rates activation charges), the display-only
 * `default_*` columns, and `default_business_model`. Those are the commercial
 * terms — a merchant setting their own take-rate at signup is the whole
 * business model handed over in a request body. A new merchant pays each
 * plan's model rate, and only an admin can negotiate anything else.
 *
 * `slug` is absent too. It is the shopfront's public URL, derived server-side
 * from the shop name: letting a stranger claim one at signup is how "melcom"
 * and "mtn" get squatted before anyone notices.
 */
export const merchantSignupCompleteSchema = z
  .object({
    signupToken: z.string().min(1),
    /** What the shop is called. Becomes the store's display name too.  */
    business_name: z.string().trim().min(1).max(200),
    /** The registered entity, which is often "… Ltd" and not the shop name. */
    legal_name: z.string().trim().min(1).max(200),
    email: z.string().email(),
    password: z.string().min(8).max(200),
    tin: z.string().trim().min(1).max(60).optional(),
    registration_number: z.string().trim().min(1).max(60).optional(),
    /**
     * What the shop mainly sells, as a category slug from
     * `GET /storefront/categories`. Optional: a seller who is not sure should not
     * be stopped at the door, and the store page lets them set it later.
     */
    primary_category_slug: z.string().trim().min(1).max(120).optional(),
    /**
     * Where the shop trades. Optional for the same reason the category is: a
     * seller who does not want to say must not be stopped at the door, and the
     * shop screen lets them set it afterwards.
     *
     * Worth asking here anyway, because it is the only thing on a storefront
     * that tells a buyer in Kumasi whether this seller is down the road or
     * across the country — and a field nobody is prompted for at signup is one
     * most shops never fill in.
     */
    city: ghanaCity.optional(),
    region: ghanaRegion.optional(),
    /**
     * Where payouts should go, as a MoMo wallet.
     *
     * Both or neither — a number without a network cannot be resolved, and a
     * network without a number is not a destination. The number is never stored
     * as given: it goes through the same resolve-then-create-recipient flow as
     * the payout-account screen, so what lands in the merchant row is an account
     * the bank has confirmed. If that flow cannot complete, signup still
     * succeeds and nothing is written.
     */
    momo_number: ghPhoneNumber.optional(),
    momo_provider: momoProviderCode.optional(),
  })
  .refine((v) => Boolean(v.momo_number) === Boolean(v.momo_provider), {
    message: 'A MoMo payout number needs its network, and a network needs a number',
    path: ['momo_provider'],
  });
export type MerchantSignupCompleteInput = z.infer<typeof merchantSignupCompleteSchema>;

export const signupVerifySchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().email().optional(),
  /** Same hard gate, same reason — see `signupCompleteSchema`. */
  date_of_birth: adultDateOfBirth,
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
