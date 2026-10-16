import { describe, expect, it } from 'vitest';
import type { SellerFees } from '@installment/api-types';
import { describeCommission, describeRates, parseBpsOverride } from './terms';

/**
 * The console's negotiated-rate fields.
 *
 * The old "MDR bps" field wrote `default_mdr_bps`, which nothing charges, and
 * `Number('')` turned a blank one into a stored 0%. Blank now has a meaning —
 * no deal, charge the plan's own rate — and is sent as NULL.
 */
describe('parseBpsOverride', () => {
  it('reads blank as "no deal", which is NULL and never 0', () => {
    expect(parseBpsOverride('', 2000)).toEqual({ ok: true, value: null });
    expect(parseBpsOverride('   ', 2000)).toEqual({ ok: true, value: null });
  });

  it('reads whole basis points, including a negotiated 0', () => {
    expect(parseBpsOverride('250', 2000)).toEqual({ ok: true, value: 250 });
    expect(parseBpsOverride(' 0 ', 2000)).toEqual({ ok: true, value: 0 });
    expect(parseBpsOverride('2000', 2000)).toEqual({ ok: true, value: 2000 });
  });

  it('refuses anything the column would refuse, instead of sending it', () => {
    for (const bad of ['2001', '-5', '2.5', '4%', 'abc', '1e3']) {
      expect(parseBpsOverride(bad, 2000).ok).toBe(false);
    }
  });
});

describe('describeRates', () => {
  const fees: SellerFees = {
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

  it('shows the span the plan types charge when there is no deal', () => {
    expect(describeRates(fees, 'mdr')).toBe('3%–5% by plan type');
    expect(describeRates(fees, 'reserve')).toBe('2%–12% by plan type');
  });

  it('shows one figure, marked, when there is a deal', () => {
    const deal: SellerFees = {
      ...fees,
      plans: {
        bnpl: { mdr_bps: 250, reserve_bps: 500 },
        layaway: { mdr_bps: 250, reserve_bps: 200 },
        hybrid: { mdr_bps: 250, reserve_bps: 700 },
        rent_to_own: { mdr_bps: 250, reserve_bps: 1200 },
      },
      mdr_negotiated: true,
    };
    expect(describeRates(deal, 'mdr')).toBe('2.50% (negotiated)');
    expect(describeRates(deal, 'reserve')).toBe('2%–12% by plan type');
  });
});

describe('describeCommission', () => {
  const base: SellerFees = {
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

  it('says when the platform default applies', () => {
    expect(describeCommission(base)).toBe('5% (platform default)');
  });

  it('marks a negotiated commission, independent of any MDR deal', () => {
    expect(
      describeCommission({ ...base, pay_now_commission_bps: 300, commission_negotiated: true }),
    ).toBe('3% (negotiated)');
  });
});
