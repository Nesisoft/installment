/**
 * Maps a Paystack decline/gateway reason to a retry intent (ported from
 * docs/design/momo-payment-orchestrator.ts). Pure data + lookup: the charge
 * orchestrator decides what to do (retry, escalate, wait) from the class.
 */
export type FailureClass = 'retryable' | 'non_retryable' | 'ambiguous';

/** Known Paystack decline reasons → class. Unknown reasons are `ambiguous`. */
export const PAYSTACK_DECLINE_MAP: Record<string, FailureClass> = {
  // Transient — retry later
  insufficient_funds: 'retryable',
  declined_by_customer: 'retryable',
  pin_timeout: 'retryable',
  expired: 'retryable',
  generic_error: 'retryable',
  network_timeout: 'retryable',

  // Permanent — never retry, escalate to operations
  invalid_account: 'non_retryable',
  fraud_block: 'non_retryable',
  account_closed: 'non_retryable',
  customer_blocked: 'non_retryable',
  blocked_card: 'non_retryable',
  unsupported_network: 'non_retryable',
};

/**
 * Classifies a decline reason. Absent/unknown reasons are `ambiguous` — the
 * orchestrator treats those like retryable but a verify-poll resolves the
 * real outcome before giving up (a Paystack 500 means "we don't know", not
 * "didn't charge").
 */
export function classifyFailure(reason: string | undefined | null): FailureClass {
  if (!reason) return 'ambiguous';
  const key = normaliseReason(reason);
  // Own keys only: a plain-object lookup answered "constructor" with a function.
  return Object.hasOwn(PAYSTACK_DECLINE_MAP, key) ? PAYSTACK_DECLINE_MAP[key]! : 'ambiguous';
}

/**
 * A reason as the map is keyed: lower case, words joined by underscores.
 *
 * Paystack sends prose. Checked against Paystack test mode (2026-10-19):
 * success is `gateway_response: "Approved"`, and a decline is a sentence. The
 * map is keyed on snake_case tokens and was matched with `toLowerCase()` alone,
 * so "Insufficient Funds" became "insufficient funds" — a space where the key
 * has an underscore — and no real reason could ever match. Every decline was
 * `ambiguous`, and the `non_retryable` half of the map was dead.
 *
 * This makes the map's own words match their prose form and adds no wording of
 * its own. Which prose Paystack uses for which outcome is learnt from real
 * traffic: `DeclineReasonReport` lists every reason this does not recognise.
 */
export function normaliseReason(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Reasons this codebase writes itself when Paystack returned no
 * `gateway_response`. They carry nothing to map, so a report of what the map
 * is missing must not count them.
 */
export const INTERNAL_FAILURE_REASONS: readonly string[] = [
  'charge_failed',
  'verify_returned_failed',
  // The verify poll's own, for an attempt that never had a reference to verify.
  'no_reference_issued',
  // The verify poll's own, for a reference Paystack has no transaction under.
  'not_found_at_paystack',
];

export type DeclineReasonSource = 'mapped' | 'internal_fallback' | 'unrecognised';

/**
 * Whether the map recognised a reason — not what to do about it.
 *
 * `classifyFailure` cannot tell "Paystack said something we don't know" from
 * "Paystack said nothing": both are `ambiguous`, and both are retried. Real
 * declines arrive as prose (see `normaliseReason`), so a reason the map has no
 * words for is `unrecognised` here, and the decline report and its alert say so
 * instead of the retry ladder quietly absorbing it.
 */
export function declineReasonSource(reason: string): DeclineReasonSource {
  const key = normaliseReason(reason);
  if (Object.hasOwn(PAYSTACK_DECLINE_MAP, key)) return 'mapped';
  if (INTERNAL_FAILURE_REASONS.includes(key)) return 'internal_fallback';
  return 'unrecognised';
}
