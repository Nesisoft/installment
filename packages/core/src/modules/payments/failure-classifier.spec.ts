import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-classifier';

describe('classifyFailure', () => {
  it('classifies known transient reasons as retryable', () => {
    expect(classifyFailure('insufficient_funds')).toBe('retryable');
    expect(classifyFailure('pin_timeout')).toBe('retryable');
    expect(classifyFailure('NETWORK_TIMEOUT')).toBe('retryable'); // case-insensitive
  });

  it('classifies known permanent reasons as non_retryable', () => {
    expect(classifyFailure('invalid_account')).toBe('non_retryable');
    expect(classifyFailure('fraud_block')).toBe('non_retryable');
    expect(classifyFailure('blocked_card')).toBe('non_retryable');
  });

  it('treats absent or unknown reasons as ambiguous', () => {
    expect(classifyFailure(undefined)).toBe('ambiguous');
    expect(classifyFailure(null)).toBe('ambiguous');
    expect(classifyFailure('')).toBe('ambiguous');
    expect(classifyFailure('some_new_paystack_code')).toBe('ambiguous');
  });
});
