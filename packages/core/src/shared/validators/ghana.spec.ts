import { describe, expect, it } from 'vitest';
import {
  ghPhoneNumber,
  ghanaCardNumber,
  momoProviderCode,
  normalizeGhPhone,
  normalizeGhanaCard,
} from './ghana';

describe('normalizeGhPhone', () => {
  it('accepts the three canonical input forms and normalizes to E.164', () => {
    expect(normalizeGhPhone('0244123456')).toBe('+233244123456');
    expect(normalizeGhPhone('233244123456')).toBe('+233244123456');
    expect(normalizeGhPhone('+233244123456')).toBe('+233244123456');
  });

  it('strips internal whitespace and dashes', () => {
    expect(normalizeGhPhone('  +233-24 412-3456  ')).toBe('+233244123456');
    expect(normalizeGhPhone('024 412 3456')).toBe('+233244123456');
  });

  it('accepts Vodafone/Telecel (05x) prefixes', () => {
    expect(normalizeGhPhone('0501234567')).toBe('+233501234567');
  });

  it('rejects non-mobile prefixes, wrong length, junk and non-strings', () => {
    expect(normalizeGhPhone('0144412345')).toBeNull(); // not 02x or 05x
    expect(normalizeGhPhone('024412345')).toBeNull(); // too short
    expect(normalizeGhPhone('02441234567')).toBeNull(); // too long
    expect(normalizeGhPhone('+1 415 555 0100')).toBeNull(); // wrong country
    expect(normalizeGhPhone('not a number')).toBeNull();
    expect(normalizeGhPhone('')).toBeNull();
    expect(normalizeGhPhone(undefined)).toBeNull();
    expect(normalizeGhPhone(244123456 as unknown as string)).toBeNull();
  });
});

describe('ghPhoneNumber schema', () => {
  it('parses valid numbers to canonical E.164', () => {
    expect(ghPhoneNumber.parse('0244123456')).toBe('+233244123456');
  });

  it('reports a clear error on invalid numbers', () => {
    const result = ghPhoneNumber.safeParse('0144412345');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/Ghanaian mobile/);
    }
  });
});

describe('normalizeGhanaCard', () => {
  it('canonicalizes accepted variants to GHA-NNNNNNNNN-N', () => {
    expect(normalizeGhanaCard('GHA-123456789-0')).toBe('GHA-123456789-0');
    expect(normalizeGhanaCard('gha-123456789-0')).toBe('GHA-123456789-0');
    expect(normalizeGhanaCard(' GHA 123456789 0 ')).toBe('GHA-123456789-0');
    expect(normalizeGhanaCard('GHA1234567890')).toBe('GHA-123456789-0');
  });

  it('rejects wrong prefixes, wrong digit counts and non-strings', () => {
    expect(normalizeGhanaCard('NIA-123456789-0')).toBeNull();
    expect(normalizeGhanaCard('GHA-12345-0')).toBeNull();
    expect(normalizeGhanaCard('GHA-123456789-A')).toBeNull();
    expect(normalizeGhanaCard(null)).toBeNull();
  });
});

describe('ghanaCardNumber schema', () => {
  it('parses and canonicalizes valid card numbers', () => {
    expect(ghanaCardNumber.parse(' gha 987654321 7 ')).toBe('GHA-987654321-7');
  });

  it('reports a clear error on invalid card numbers', () => {
    const result = ghanaCardNumber.safeParse('NIA-1-2');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/Ghana Card/);
    }
  });
});

describe('momoProviderCode schema', () => {
  it('accepts the three CHECK-constraint codes', () => {
    expect(momoProviderCode.parse('mtn')).toBe('mtn');
    expect(momoProviderCode.parse('tgo')).toBe('tgo');
    expect(momoProviderCode.parse('vod')).toBe('vod');
  });

  it('rejects anything else (case-sensitive)', () => {
    expect(momoProviderCode.safeParse('MTN').success).toBe(false);
    expect(momoProviderCode.safeParse('glo').success).toBe(false);
    expect(momoProviderCode.safeParse('').success).toBe(false);
  });
});
