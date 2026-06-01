import { describe, expect, it } from 'vitest';
import { PayoutCalculator } from './payout-calculator';
import { MODEL_CONFIG } from './model-config';

describe('PayoutCalculator — BNPL', () => {
  it('splits a 1,000 GHS order on order_approved (4% MDR, 5% reserve)', () => {
    const b = PayoutCalculator.calculate(100_000, 'bnpl', 'order_approved')!;
    expect(b.grossPesewas).toBe(100_000);
    expect(b.mdrPesewas).toBe(4_000);
    expect(b.reservePesewas).toBe(5_000);
    expect(b.netPesewas).toBe(91_000);
    expect(b.platformRevenuePesewas).toBe(4_000);
    expect(b.netPesewas + b.mdrPesewas + b.reservePesewas).toBe(b.grossPesewas);
  });

  it('returns null for a trigger this model does not pay out on', () => {
    expect(PayoutCalculator.calculate(100_000, 'bnpl', 'plan_completed')).toBeNull();
  });
});

describe('PayoutCalculator — hybrid (two splits)', () => {
  it('pays 40% on down_payment_received and 60% on plan_completed', () => {
    const down = PayoutCalculator.calculate(100_000, 'hybrid', 'down_payment_received')!;
    expect(down.grossPesewas).toBe(40_000);
    expect(down.mdrPesewas).toBe(1_600); // 4% of 40k
    expect(down.reservePesewas).toBe(2_800); // 7% of 40k
    expect(down.netPesewas).toBe(35_600);

    const completed = PayoutCalculator.calculate(100_000, 'hybrid', 'plan_completed')!;
    expect(completed.grossPesewas).toBe(60_000);
    expect(completed.netPesewas).toBe(60_000 - 2_400 - 4_200);

    // The two slices sum to the full order.
    expect(down.grossPesewas + completed.grossPesewas).toBe(100_000);
  });
});

describe('PayoutCalculator — layaway and rent_to_own', () => {
  it('layaway only pays out on plan_completed', () => {
    expect(PayoutCalculator.calculate(50_000, 'layaway', 'order_approved')).toBeNull();
    const b = PayoutCalculator.calculate(50_000, 'layaway', 'plan_completed')!;
    expect(b.mdrPesewas).toBe(1_500); // 3%
    expect(b.reservePesewas).toBe(1_000); // 2%
    expect(b.netPesewas).toBe(47_500);
  });

  it('rent_to_own pays out upfront with a heavy 12% reserve', () => {
    const b = PayoutCalculator.calculate(200_000, 'rent_to_own', 'order_approved')!;
    expect(b.mdrPesewas).toBe(10_000); // 5%
    expect(b.reservePesewas).toBe(24_000); // 12%
    expect(b.netPesewas).toBe(166_000);
  });
});

describe('PayoutCalculator — money invariants', () => {
  it('keeps net + mdr + reserve === gross across every model + trigger', () => {
    for (const model of Object.keys(MODEL_CONFIG) as Array<keyof typeof MODEL_CONFIG>) {
      for (const split of MODEL_CONFIG[model].payoutSplits) {
        const b = PayoutCalculator.calculate(123_457, model, split.trigger);
        if (b) {
          expect(b.netPesewas + b.mdrPesewas + b.reservePesewas).toBe(b.grossPesewas);
        }
      }
    }
  });

  it('rounds with ROUND_HALF_UP (no fractional pesewas)', () => {
    const b = PayoutCalculator.calculate(33, 'bnpl', 'order_approved')!;
    // 4% of 33 = 1.32 → rounds to 1; 5% of 33 = 1.65 → rounds to 2.
    expect(b.mdrPesewas).toBe(1);
    expect(b.reservePesewas).toBe(2);
    expect(Number.isInteger(b.netPesewas)).toBe(true);
  });
});
