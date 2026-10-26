/**
 * The address a phone-signup account is given when the customer offers no
 * email. Customers sign in by phone and OTP, and the users/customers `email`
 * columns are NOT NULL and UNIQUE, so the column holds `<phone>@` this domain —
 * a value that satisfies the schema and reaches no inbox.
 *
 * It is a storage detail, never the customer's email: a profile that showed it
 * presented an address they never gave as one we would write to. Readers that
 * show an email to a person ask `isPlaceholderEmail` first.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'customer.installment.local';

export function placeholderEmailFor(phone: string): string {
  return `${phone}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email) && email!.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** The customer's own email, or null when the account only has the placeholder. */
export function realEmail(email: string | null | undefined): string | null {
  return email && !isPlaceholderEmail(email) ? email : null;
}
