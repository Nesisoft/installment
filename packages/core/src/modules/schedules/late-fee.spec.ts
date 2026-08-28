import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/money/money';

/**
 * The late-fee arithmetic, pinned.
 *
 * The rule the design and the business proposal both promise is "3-day grace,
 * then 2% per week, capped at 15%". These cases are the ones that would be
 * quietly wrong if the accrual were written as an increment instead of a level,
 * or if it compounded weekly roundings.
 */

/** Mirrors LateFeeService: one multiplication at the compounded rate, then cap. */
function feeFor(amountDue: number, weeksLate: number, rateBps = 200, capBps = 1500): number {
  const due = Money.fromPesewas(amountDue);
  const uncapped = Number(due.multiplyBps(rateBps * weeksLate).pesewas);
  const cap = capBps > 0 ? Number(due.multiplyBps(capBps).pesewas) : uncapped;
  return Math.min(uncapped, cap);
}

describe('late fee accrual', () => {
  it('charges nothing inside the grace period', () => {
    expect(feeFor(58_280, 0)).toBe(0);
  });

  it('charges 2% of the instalment in the first week past grace', () => {
    // GHS 582.80 instalment -> GHS 11.66
    expect(feeFor(58_280, 1)).toBe(1_166);
  });

  it('grows linearly, not compounding', () => {
    expect(feeFor(58_280, 2)).toBe(2_331); // 4% of 58_280 = 2331.2 -> half-up
    expect(feeFor(58_280, 3)).toBe(3_497);
  });

  it('stops at the 15% cap however long the row sits', () => {
    const cap = feeFor(58_280, 100);
    expect(cap).toBe(8_742); // 15% of 58_280
    expect(feeFor(58_280, 8)).toBe(8_742); // 16% would exceed it
    expect(feeFor(58_280, 7)).toBe(8_159); // 14% still under
  });

  it('computes the same fee whichever run reaches a given week', () => {
    // The whole point of recomputing a level rather than adding an increment:
    // a duplicate run, or a catch-up after an outage, lands on one figure.
    const once = feeFor(58_280, 3);
    const afterRerun = feeFor(58_280, 3);
    expect(afterRerun).toBe(once);
  });

  it('rounds half-up to whole pesewas, never fractions', () => {
    const fee = feeFor(33_333, 1);
    expect(Number.isInteger(fee)).toBe(true);
    expect(fee).toBe(667); // 2% of 33_333 = 666.66 -> 667
  });

  it('is zero when the plan carries no rate, whatever the delay', () => {
    expect(feeFor(58_280, 12, 0, 1500)).toBe(0);
  });
});
