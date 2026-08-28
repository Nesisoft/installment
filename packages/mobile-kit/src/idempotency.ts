/**
 * Mints a key for an endpoint guarded by `Idempotency-Key`.
 *
 * Every endpoint that moves money or creates a financial commitment requires
 * one, and reusing the same value on a retry is what makes the operation apply
 * at most once. Mint a key per logical user action (one tap = one key) and reuse
 * it if you retry that action; do not mint a new one mid-retry.
 *
 * This matters more on a handset than in a browser: a MoMo charge is approved by
 * leaving the app for the MoMo dialler, and a customer who comes back to a
 * spinner and taps Pay again must not be debited twice.
 */
export function newIdempotencyKey(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const rand =
    typeof g.crypto?.randomUUID === 'function'
      ? g.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}

/** Request config fragment carrying a freshly minted idempotency key. */
export function idempotent(prefix: string): { headers: Record<string, string> } {
  return { headers: { 'Idempotency-Key': newIdempotencyKey(prefix) } };
}
