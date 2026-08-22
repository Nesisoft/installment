/**
 * Mints a key for an endpoint guarded by `Idempotency-Key`.
 *
 * Every endpoint that moves money or creates a financial commitment requires
 * one, and reusing the same value on a retry is what makes the operation apply
 * at most once. Mint a key per logical user action (one click = one key) and
 * reuse it if you retry that action; do not mint a new one mid-retry.
 */
export function newIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}

/** Request config fragment carrying a freshly minted idempotency key. */
export function idempotent(prefix: string): { headers: Record<string, string> } {
  return { headers: { 'Idempotency-Key': newIdempotencyKey(prefix) } };
}
