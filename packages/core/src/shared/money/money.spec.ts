import { describe, expect, it } from 'vitest';
import { Money } from './money';

describe('Money construction', () => {
  it('fromPesewas accepts integers, bigints and integer strings', () => {
    expect(Money.fromPesewas(100).pesewas).toBe(100n);
    expect(Money.fromPesewas(100n).pesewas).toBe(100n);
    expect(Money.fromPesewas('100').pesewas).toBe(100n);
    expect(Money.fromPesewas(-50).pesewas).toBe(-50n);
    expect(Money.zero().pesewas).toBe(0n);
  });

  it('fromPesewas rejects non-integers and junk', () => {
    expect(() => Money.fromPesewas(1.5)).toThrow(TypeError);
    expect(() => Money.fromPesewas(Number.NaN)).toThrow(TypeError);
    expect(() => Money.fromPesewas('1.5')).toThrow(TypeError);
    expect(() => Money.fromPesewas('abc')).toThrow(TypeError);
    expect(() => Money.fromPesewas(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('fromCedis multiplies by 100 with ROUND_HALF_UP', () => {
    expect(Money.fromCedis('1').pesewas).toBe(100n);
    expect(Money.fromCedis('12.34').pesewas).toBe(1234n);
    expect(Money.fromCedis('0.005').pesewas).toBe(1n); // half rounds up
    expect(Money.fromCedis('0.004').pesewas).toBe(0n);
    expect(Money.fromCedis('-1.235').pesewas).toBe(-124n); // HALF_UP on magnitude
    expect(Money.fromCedis(1234.567).pesewas).toBe(123457n);
  });

  it('fromCedis rejects non-finite input', () => {
    expect(() => Money.fromCedis(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => Money.fromCedis('not-a-number')).toThrow();
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts without precision loss', () => {
    const a = Money.fromPesewas(10_000);
    const b = Money.fromPesewas(2_500);
    expect(a.add(b).pesewas).toBe(12_500n);
    expect(a.subtract(b).pesewas).toBe(7_500n);
    expect(a.subtract(20_000).pesewas).toBe(-10_000n);
    expect(a.negate().pesewas).toBe(-10_000n);
  });

  it('is immutable — operations return new instances', () => {
    const a = Money.fromPesewas(100);
    const b = a.add(50);
    expect(a.pesewas).toBe(100n);
    expect(b.pesewas).toBe(150n);
    expect(b).not.toBe(a);
  });

  it('multiplyBps matches the settlement reference cases', () => {
    const order = Money.fromPesewas(100_000);
    expect(order.multiplyBps(400).pesewas).toBe(4_000n); // 4% MDR
    expect(order.multiplyBps(500).pesewas).toBe(5_000n); // 5% reserve

    const hybridDp = Money.fromPesewas(40_000);
    expect(hybridDp.multiplyBps(400).pesewas).toBe(1_600n);
    expect(hybridDp.multiplyBps(700).pesewas).toBe(2_800n);
  });

  it('multiplyBps rounds HALF_UP to whole pesewas', () => {
    // 12345 * 250 / 10000 = 308.625 -> 309
    expect(Money.fromPesewas(12_345).multiplyBps(250).pesewas).toBe(309n);
    // 1 * 5000 / 10000 = 0.5 -> 1
    expect(Money.fromPesewas(1).multiplyBps(5000).pesewas).toBe(1n);
    expect(Money.fromPesewas(0).multiplyBps(400).pesewas).toBe(0n);
  });

  it('multiplyBps rejects non-integer bps', () => {
    expect(() => Money.fromPesewas(100).multiplyBps(4.5)).toThrow(TypeError);
  });
});

describe('Money comparison', () => {
  it('compares and tests equality', () => {
    const a = Money.fromPesewas(100);
    expect(a.equals(100)).toBe(true);
    expect(a.equals(Money.fromPesewas(100))).toBe(true);
    expect(a.compare(200)).toBe(-1);
    expect(a.compare(50)).toBe(1);
    expect(a.compare(100)).toBe(0);
    expect(a.greaterThan(99)).toBe(true);
    expect(a.lessThan(101)).toBe(true);
    expect(a.gte(100)).toBe(true);
    expect(a.lte(100)).toBe(true);
  });

  it('reports sign correctly', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.fromPesewas(1).isPositive()).toBe(true);
    expect(Money.fromPesewas(-1).isNegative()).toBe(true);
    expect(Money.fromPesewas(-1).isPositive()).toBe(false);
  });
});

describe('Money formatting & serialization', () => {
  it('formats with grouping and two decimals', () => {
    expect(Money.fromPesewas(123_456).format()).toBe('GHS 1,234.56');
    expect(Money.fromPesewas(5).format()).toBe('GHS 0.05');
    expect(Money.zero().format()).toBe('GHS 0.00');
    expect(Money.fromPesewas(100_000_000).format()).toBe('GHS 1,000,000.00');
    expect(Money.fromPesewas(-123_456).format()).toBe('-GHS 1,234.56');
    expect(Money.fromPesewas(123_456).format('NGN')).toBe('NGN 1,234.56');
    expect(Money.fromPesewas(99).toString()).toBe('GHS 0.99');
  });

  it('serializes to a bigint-safe pesewas string', () => {
    expect(Money.fromPesewas(123_456).toJSON()).toBe('123456');
    expect(JSON.stringify({ amount: Money.fromPesewas(100) })).toBe('{"amount":"100"}');
  });

  it('round-trips through pesewas', () => {
    const original = Money.fromCedis('8765.43');
    const restored = Money.fromPesewas(original.pesewas);
    expect(restored.equals(original)).toBe(true);
    expect(restored.format()).toBe('GHS 8,765.43');
  });
});
