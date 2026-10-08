import { describe, expect, it } from 'vitest';
import { parseGhsToPesewas, pesewasToGhsInput } from './money';

/**
 * The seller types a price; this is where it becomes money.
 *
 * Every amount a merchant sets — a product price, a "was" price — passes
 * through here on its way to a `*_pesewas` column, and nothing downstream can
 * recover from it being wrong. The implementation parses the digits rather
 * than multiplying a float precisely so GHS 289.90 cannot arrive as 28989.
 * These cases pin that, and pin the rejections: a field that quietly coerced
 * junk to a number would bill it.
 */
describe('parseGhsToPesewas', () => {
  it('converts whole and fractional cedis exactly', () => {
    expect(parseGhsToPesewas('289.90')).toBe(28_990);
    expect(parseGhsToPesewas('0.01')).toBe(1);
    expect(parseGhsToPesewas('0')).toBe(0);
    expect(parseGhsToPesewas('1')).toBe(100);
    expect(parseGhsToPesewas('1234')).toBe(123_400);
  });

  it('treats a single decimal place as tenths, not hundredths', () => {
    // "289.9" is GHS 289.90, not GHS 289.09.
    expect(parseGhsToPesewas('289.9')).toBe(28_990);
    expect(parseGhsToPesewas('0.5')).toBe(50);
  });

  it('never loses a pesewa to float multiplication', () => {
    // The amounts where `Math.round(x * 100)` is classically unsafe.
    for (const [input, pesewas] of [
      ['1.10', 110],
      ['2.30', 230],
      ['8.20', 820],
      ['16.08', 1_608],
      ['1.005', null],
    ] as const) {
      expect(parseGhsToPesewas(input)).toBe(pesewas);
    }
  });

  it('accepts thousands separators and surrounding space', () => {
    expect(parseGhsToPesewas(' 1,234.56 ')).toBe(123_456);
    expect(parseGhsToPesewas('1,000,000')).toBe(100_000_000);
  });

  it('returns null rather than a number for anything that is not an amount', () => {
    for (const bad of ['', '   ', 'abc', '12abc', '-5', '1.234', '.5', '1.', '1e3', '٣']) {
      expect(parseGhsToPesewas(bad)).toBeNull();
    }
  });
});

describe('pesewasToGhsInput', () => {
  it('round-trips through the parser', () => {
    for (const pesewas of [0, 1, 50, 110, 28_990, 123_456, 100_000_000]) {
      expect(parseGhsToPesewas(pesewasToGhsInput(pesewas))).toBe(pesewas);
    }
  });

  it('always shows two decimal places', () => {
    expect(pesewasToGhsInput(0)).toBe('0.00');
    expect(pesewasToGhsInput(5)).toBe('0.05');
    expect(pesewasToGhsInput(28_990)).toBe('289.90');
  });
});
