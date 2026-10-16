import { describe, expect, it } from 'vitest';
import { classifyFailure, declineReasonSource } from './failure-classifier';

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

/**
 * Whether the map recognised a reason at all — the question the decline
 * report and its alert answer from real traffic.
 *
 * Every reason reaching the classifier is Paystack's `gateway_response`. The
 * map is keyed on snake_case tokens and so are the repo's fixtures, so the
 * specs pass; whether real Paystack sends those tokens or prose has never been
 * checked against a real decline. If it sends prose, every decline classifies
 * as `ambiguous` and is retried, and nothing says so. This labelling is what
 * makes that visible instead of silent.
 */
describe('declineReasonSource', () => {
  it('recognises a reason the map has, in any case', () => {
    expect(declineReasonSource('insufficient_funds')).toBe('mapped');
    expect(declineReasonSource('BLOCKED_CARD')).toBe('mapped');
  });

  it('names the placeholders this codebase writes when Paystack gave no reason', () => {
    // Ours, not Paystack's: they carry no information to map, and must not be
    // reported as a gap in the map.
    expect(declineReasonSource('charge_failed')).toBe('internal_fallback');
    expect(declineReasonSource('verify_returned_failed')).toBe('internal_fallback');
  });

  it('reports a reason the map does not know as unrecognised, prose included', () => {
    expect(declineReasonSource('Insufficient Funds')).toBe('unrecognised');
    expect(declineReasonSource('Declined')).toBe('unrecognised');
    expect(declineReasonSource('some_new_code')).toBe('unrecognised');
  });

  it('agrees with classifyFailure: only a mapped reason is ever acted on', () => {
    for (const reason of ['insufficient_funds', 'Insufficient Funds', 'charge_failed', 'x']) {
      expect(classifyFailure(reason) === 'ambiguous').toBe(
        declineReasonSource(reason) !== 'mapped',
      );
    }
  });
});
