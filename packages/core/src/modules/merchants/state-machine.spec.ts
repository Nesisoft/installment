import { describe, expect, it } from 'vitest';
import { IllegalMerchantTransitionError, canTransition, nextMerchantStatus } from './state-machine';

describe('merchants state machine', () => {
  it('allows the canonical happy-path transitions', () => {
    expect(nextMerchantStatus('pending_kyc', 'activate')).toBe('active');
    expect(nextMerchantStatus('active', 'suspend')).toBe('suspended');
    expect(nextMerchantStatus('suspended', 'reactivate')).toBe('active');
    expect(nextMerchantStatus('active', 'offboard')).toBe('offboarded');
    expect(nextMerchantStatus('suspended', 'offboard')).toBe('offboarded');
  });

  it('refuses to leave the offboarded terminal state', () => {
    expect(() => nextMerchantStatus('offboarded', 'activate')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('offboarded', 'suspend')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('offboarded', 'reactivate')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('offboarded', 'offboard')).toThrow(
      IllegalMerchantTransitionError,
    );
  });

  it('refuses other illegal transitions', () => {
    expect(() => nextMerchantStatus('pending_kyc', 'suspend')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('pending_kyc', 'reactivate')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('pending_kyc', 'offboard')).toThrow(
      IllegalMerchantTransitionError,
    );
    expect(() => nextMerchantStatus('active', 'activate')).toThrow(IllegalMerchantTransitionError);
    expect(() => nextMerchantStatus('suspended', 'suspend')).toThrow(
      IllegalMerchantTransitionError,
    );
  });

  it('canTransition is a non-throwing twin of nextMerchantStatus', () => {
    expect(canTransition('pending_kyc', 'activate')).toBe(true);
    expect(canTransition('active', 'reactivate')).toBe(false);
    expect(canTransition('offboarded', 'activate')).toBe(false);
  });
});
