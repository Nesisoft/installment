/**
 * Retry policy for failed installment debits (ported from
 * docs/design/momo-payment-orchestrator.ts). Data, not branching logic:
 * each step says when to retry (delay from now) and which channel to use
 * (auto-debit retry, then a payment link as the final fallback) so a
 * scheduler / worker can act without rule-by-rule branching.
 */
export interface RetryStep {
  /** 1-based attempt number this step represents. */
  attempt: number;
  /** Hours to wait after the previous failure before this attempt. */
  delayHours: number;
  /** How to charge on this attempt. */
  channel: 'auto_debit' | 'payment_link';
  /** Pre-debit reminder window, minutes before the attempt fires. */
  reminderMinutesBefore: number;
}

export const RETRY_POLICY: ReadonlyArray<RetryStep> = [
  { attempt: 1, delayHours: 0, channel: 'auto_debit', reminderMinutesBefore: 60 },
  { attempt: 2, delayHours: 4, channel: 'auto_debit', reminderMinutesBefore: 30 },
  { attempt: 3, delayHours: 24, channel: 'auto_debit', reminderMinutesBefore: 60 },
  { attempt: 4, delayHours: 48, channel: 'payment_link', reminderMinutesBefore: 0 },
];

export const MAX_ATTEMPTS = RETRY_POLICY.length;

/**
 * The retry step for a given 1-based attempt number, or `undefined` when
 * `attempt` exceeds {@link MAX_ATTEMPTS} (out of retries — escalate to
 * collections instead).
 */
export function retryStepFor(attempt: number): RetryStep | undefined {
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  return RETRY_POLICY[attempt - 1];
}

/**
 * Max times to poll /transaction/verify for one attempt before giving up.
 *
 * Sized against how long a real MoMo approval takes, not how fast we would
 * like an answer. A customer may be away from their handset, on a congested
 * network, or topping up before approving; USSD approvals routinely take far
 * longer than ten minutes. With the 5-minute sweep and a 15-minute staleness
 * threshold this spans roughly 45 minutes, matching the reference design.
 *
 * Getting this wrong is expensive in one direction only: giving up early
 * converts "we don't know" into "failed", which schedules a retry and can
 * issue a fresh charge while the customer's original prompt is still live on
 * their phone. Polling a few more times costs an API call.
 */
export const MAX_VERIFY_POLLS = 6;
