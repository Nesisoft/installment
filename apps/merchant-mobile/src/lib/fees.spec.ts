import { describe, expect, it } from 'vitest';
import type { SellerFees } from '@installment/api-types';
import { bpsShare, feeSentence, pctSpan, saleSplits } from './fees';

/**
 * What a sale leaves the seller, as the app prints it.
 *
 * Every fee figure in the app was `default_mdr_bps` — a flat 4% — and every
 * reserve a flat 5%. Nothing charges those columns. A paid-in-full order takes
 * the 5% marketplace commission; a plan takes its own model's rates (3–5% fee,
 * 2–12% held) or the merchant's deal. The arithmetic floored where the engine
 * rounds half-up, under a comment saying it matched.
 */
const MODEL_RATES: SellerFees = {
  pay_now_commission_bps: 500,
  plans: {
    bnpl: { mdr_bps: 400, reserve_bps: 500 },
    layaway: { mdr_bps: 300, reserve_bps: 200 },
    hybrid: { mdr_bps: 400, reserve_bps: 700 },
    rent_to_own: { mdr_bps: 500, reserve_bps: 1200 },
  },
  mdr_negotiated: false,
  reserve_negotiated: false,
  commission_negotiated: false,
};

const NEGOTIATED: SellerFees = {
  ...MODEL_RATES,
  plans: {
    bnpl: { mdr_bps: 250, reserve_bps: 500 },
    layaway: { mdr_bps: 250, reserve_bps: 200 },
    hybrid: { mdr_bps: 250, reserve_bps: 700 },
    rent_to_own: { mdr_bps: 250, reserve_bps: 1200 },
  },
  mdr_negotiated: true,
};

describe('bpsShare', () => {
  it('rounds half-up to the pesewa, the way `Money.multiplyBps` books it', () => {
    // 12,345 × 2.5% = 308.625 — the engine books 309; a floor showed 308.
    expect(bpsShare(12_345, 250)).toBe(309);
    // 1 × 50% = 0.5 → 1.
    expect(bpsShare(1, 5_000)).toBe(1);
    expect(bpsShare(10_000, 400)).toBe(400);
    expect(bpsShare(0, 400)).toBe(0);
  });
});

describe('pctSpan', () => {
  it('prints one figure when every value agrees, and a span when they do not', () => {
    expect(pctSpan([250, 250, 250])).toBe('2.5%');
    expect(pctSpan([400, 300, 400, 500])).toBe('3–5%');
    expect(pctSpan([200, 1200])).toBe('2–12%');
  });
});

describe('saleSplits', () => {
  it('charges a paid-in-full sale the commission, with nothing held', () => {
    const [payNow] = saleSplits(10_000, MODEL_RATES, []);
    expect(payNow).toMatchObject({ key: 'pay_now', feeBps: 500, fee: 500, reserve: 0, net: 9_500 });
  });

  it('prices each plan type the buyer could pick at its own rates', () => {
    const splits = saleSplits(10_000, MODEL_RATES, ['layaway', 'rent_to_own']);
    expect(splits.map((s) => [s.key, s.fee, s.reserve, s.net])).toEqual([
      ['pay_now', 500, 0, 9_500],
      ['layaway', 300, 200, 9_500],
      ['rent_to_own', 500, 1_200, 8_300],
    ]);
  });

  it('lists each plan type once, in a fixed order, however the templates arrive', () => {
    const splits = saleSplits(10_000, MODEL_RATES, ['hybrid', 'bnpl', 'hybrid', 'bnpl']);
    expect(splits.map((s) => s.key)).toEqual(['pay_now', 'bnpl', 'hybrid']);
  });

  it('shows a negotiated MDR on every plan', () => {
    const splits = saleSplits(10_000, NEGOTIATED, ['bnpl', 'layaway']);
    expect(splits.slice(1).map((s) => s.feeBps)).toEqual([250, 250]);
  });

  it('always adds back up to the sale', () => {
    for (const price of [1, 999, 12_345, 28_990, 1_000_000]) {
      for (const s of saleSplits(price, MODEL_RATES, [
        'bnpl',
        'layaway',
        'hybrid',
        'rent_to_own',
      ])) {
        expect(s.net + s.fee + s.reserve).toBe(price);
      }
    }
  });
});

describe('feeSentence', () => {
  it('names both fees, and says the plan decides when the plans differ', () => {
    expect(feeSentence(MODEL_RATES)).toBe(
      "Ejua's fee is 5% on a paid-in-full order, and 3–5% on an instalment sale depending on the plan the buyer picks.",
    );
  });

  it('gives a merchant with a deal one flat figure', () => {
    expect(feeSentence(NEGOTIATED)).toBe(
      "Ejua's fee is 5% on a paid-in-full order, and 2.5% on every instalment sale.",
    );
  });
});
