import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, RETRY_POLICY, retryStepFor } from './retry-policy';

describe('RETRY_POLICY', () => {
  it('starts immediately and ends on a payment-link fallback', () => {
    expect(MAX_ATTEMPTS).toBe(4);
    expect(RETRY_POLICY[0]?.delayHours).toBe(0);
    expect(RETRY_POLICY.at(-1)?.channel).toBe('payment_link');
    expect(RETRY_POLICY.map((s) => s.delayHours)).toEqual([0, 4, 24, 48]);
  });
});

describe('retryStepFor', () => {
  it('returns the step for valid attempt numbers (1-based)', () => {
    expect(retryStepFor(1)?.attempt).toBe(1);
    expect(retryStepFor(4)?.channel).toBe('payment_link');
  });

  it('returns undefined when the attempt count is exhausted or invalid', () => {
    expect(retryStepFor(0)).toBeUndefined();
    expect(retryStepFor(-1)).toBeUndefined();
    expect(retryStepFor(5)).toBeUndefined();
    expect(retryStepFor(1.5)).toBeUndefined();
  });
});
