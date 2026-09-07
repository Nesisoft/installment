import { describe, expect, it } from 'vitest';
import { parseGhsToPesewas } from './format';

/**
 * The seller types the price. Everything downstream — what the customer is
 * charged, the MDR, the reserve, the payout — is derived from this one number,
 * so a rounding error here is money.
 */
describe('parseGhsToPesewas', () => {
  it('reads whole cedis and pesewas', () => {
    expect(parseGhsToPesewas('320')).toBe(32000);
    expect(parseGhsToPesewas('320.50')).toBe(32050);
    expect(parseGhsToPesewas('0.05')).toBe(5);
    expect(parseGhsToPesewas('289.90')).toBe(28990);
  });

  it('reads one decimal place as tenths, not hundredths', () => {
    // "320.5" is three hundred and twenty cedis fifty pesewas, not five.
    expect(parseGhsToPesewas('320.5')).toBe(32050);
  });

  it('does not go through a float', () => {
    // 320.15 * 100 is 32014.999999999996 in IEEE 754. Multiplying and rounding
    // happens to survive this one; parsing the digits cannot fail on any of
    // them, which is why it is done that way.
    expect(parseGhsToPesewas('320.15')).toBe(32015);
    expect(parseGhsToPesewas('1.10')).toBe(110);
    expect(parseGhsToPesewas('8.20')).toBe(820);
  });

  it('accepts the thousands separators a seller types', () => {
    expect(parseGhsToPesewas('1,200.00')).toBe(120000);
    expect(parseGhsToPesewas(' 12,999 ')).toBe(1299900);
    // Every comma goes, wherever it is, so a stray one is a typo that still
    // means what it looks like rather than a refusal the seller has to hunt.
    expect(parseGhsToPesewas('20,')).toBe(2000);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of ['', '  ', 'free', 'GHS 20', '20.', '.20', '-20', '20.999', '2e3', '2 0']) {
      expect(parseGhsToPesewas(bad)).toBeNull();
    }
  });
});
