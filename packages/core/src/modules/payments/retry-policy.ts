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

/** Max times to poll /transaction/verify for one attempt before giving up. */
export const MAX_VERIFY_POLLS = 2;
