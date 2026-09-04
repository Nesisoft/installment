import { describe, expect, it } from 'vitest';
import { isGhanaCardNumber, normaliseGhanaCardNumber } from './ghana-card';

describe('isGhanaCardNumber', () => {
  it('accepts the canonical form', () => {
    expect(isGhanaCardNumber('GHA-123456789-0')).toBe(true);
  });

  it('accepts what a phone keyboard actually produces', () => {
    // Lower case, spaces for dashes, the compact run, and stray padding — all
    // of which a shopper types and none of which is a mistake worth an error.
    for (const input of [
      'gha-123456789-0',
      'GHA 123456789 0',
      'GHA1234567890',
      '  GHA-123456789-0  ',
    ]) {
      expect(isGhanaCardNumber(input), input).toBe(true);
    }
  });

  it('rejects the near-misses', () => {
    for (const input of [
      'GHA-12345678-0', // eight digits
      'GHA-1234567890-0', // ten
      'GHA-123456789', // no check digit
      'GH-123456789-0', // not the prefix
      '123456789-0',
      '',
    ]) {
      expect(isGhanaCardNumber(input), input).toBe(false);
    }
  });
});

describe('normaliseGhanaCardNumber', () => {
  it('produces the one form the server stores', () => {
    // Same canonical output as core's `normalizeGhanaCard`, so what the app
    // sends is what comes back and the customer sees their own number
    // unchanged.
    for (const input of ['gha 123456789 0', 'GHA1234567890', 'GHA-123456789-0']) {
      expect(normaliseGhanaCardNumber(input), input).toBe('GHA-123456789-0');
    }
  });

  it('returns null rather than a half-normalised guess', () => {
    expect(normaliseGhanaCardNumber('GHA-12345-0')).toBeNull();
    expect(normaliseGhanaCardNumber('nonsense')).toBeNull();
  });
});
