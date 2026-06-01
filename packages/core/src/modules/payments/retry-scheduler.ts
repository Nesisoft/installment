/**
 * Port for scheduling the next debit attempt after a retryable failure. The
 * production implementation enqueues a delayed BullMQ job; tests inject a fake.
 * Kept framework-free so @installment/core never depends on a queue client.
 */
export interface RetryJob {
  scheduleId: string;
  /** 1-based attempt number this retry represents (the NEXT attempt). */
  attempt: number;
  /** How the retry should charge — auto-debit, or a payment link on attempt 4. */
  channel: 'auto_debit' | 'payment_link';
  /** Delay before the retry should fire, in milliseconds. */
  delayMs: number;
}

export interface RetryScheduler {
  scheduleRetry(job: RetryJob): Promise<void>;
}
