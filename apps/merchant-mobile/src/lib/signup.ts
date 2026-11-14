import { merchantSignupCompleteSchema, phoneSchema } from '@installment/api-types';

/**
 * Opening a shop from the app, as plain functions so the rules can be tested
 * in node. The screen is `app/sign-up.tsx`.
 */

/**
 * The phone number as the API will accept it, or null.
 *
 * People type numbers the way they say them — "024 455 1338", "+233-24-455-1338"
 * — so spaces, dashes and brackets are dropped before the API's own rule
 * (`phoneSchema`: a leading 0 or 233, then nine digits) is applied.
 */
export function signupPhone(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, '');
  return phoneSchema.safeParse(compact).success ? compact : null;
}

export interface BusinessDetails {
  businessName: string;
  legalName: string;
  email: string;
  password: string;
  tin: string;
}

/**
 * The body for `POST /auth/merchant/signup/complete`, or the first thing wrong
 * with what was typed.
 *
 * Validated against the API's own schema rather than a copy of its rules, so
 * the app cannot accept a form the server will refuse. Only what creating the
 * account needs is asked here: the shop's category, market and region and its
 * payout number are the onboarding screen's first and last steps, so a seller
 * is not asked for anything twice. The TIN is the exception — nothing after
 * signup collects it, and the website's form asked for it too.
 */
export function businessDetailsBody(
  signupToken: string,
  details: BusinessDetails,
):
  | { ok: true; body: ReturnType<typeof merchantSignupCompleteSchema.parse> }
  | { ok: false; error: string } {
  const parsed = merchantSignupCompleteSchema.safeParse({
    signupToken,
    business_name: details.businessName.trim(),
    legal_name: details.legalName.trim(),
    email: details.email.trim().toLowerCase(),
    password: details.password,
    ...(details.tin.trim() ? { tin: details.tin.trim() } : {}),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: FIELD_MESSAGES[String(issue?.path[0])] ?? 'Check the details and try again.',
  };
}

/** What to say for each field, in the seller's words rather than the schema's. */
const FIELD_MESSAGES: Record<string, string> = {
  business_name: 'Give your shop a name.',
  legal_name: 'Add the name your business is registered under, or your own name.',
  email: 'That email address does not look right.',
  password: 'Your password needs at least 8 characters.',
  tin: 'That TIN is too long.',
  signupToken: 'Your code has expired. Go back and ask for a new one.',
};
