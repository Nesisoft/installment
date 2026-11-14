/**
 * Where a shopper lands after paying on Paystack's page.
 *
 * Kept free of React Native imports so it can be tested in node; the binding
 * to `expo-web-browser` lives in `payment-page.ts`.
 */

/** Where to go when the return carries no usable destination. */
export const DEFAULT_RETURN_PATH = '/orders';

/**
 * The in-app path to send a returning shopper to, from the `next` parameter on
 * the return URL.
 *
 * Only a path inside this app is accepted. The return URL passes through
 * Paystack and back, and anything in it can be edited by whoever holds the
 * link; a `next` that could name another site would let a crafted payment link
 * end on a look-alike page asking for a PIN.
 */
export function safeReturnPath(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value) return DEFAULT_RETURN_PATH;
  // One leading slash, then a path. `//host` and `/\host` are other sites to a
  // browser, and a scheme anywhere is a URL rather than a path.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return DEFAULT_RETURN_PATH;
  }
  // A backslash or colon anywhere could turn the path back into a URL, and a
  // control character (a newline, a tab) has no business in one.
  if (/[\\:]/.test(value) || [...value].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return DEFAULT_RETURN_PATH;
  }
  return value;
}
