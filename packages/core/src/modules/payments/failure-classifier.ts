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
  return PAYSTACK_DECLINE_MAP[reason.toLowerCase()] ?? 'ambiguous';
}
