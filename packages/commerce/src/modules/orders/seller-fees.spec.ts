import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKETPLACE_COMMISSION_BPS } from './orders.service';
import { sellerFees } from './seller-fees';

/**
 * What a seller is told a sale costs them.
 *
 * Every fee figure in the seller's app came from `merchants.default_mdr_bps`:
 * a flat 4% on every screen. Nothing charges that column. A paid-in-full order
 * takes the 5% marketplace commission; an instalment sale takes the MDR of the
 * plan the buyer picks — 3% on layaway, 5% on rent-to-own — or the merchant's
 * negotiated rate if they have one. The reserve shown was a flat 5% against a
 * real 2–12%.
 */
describe('sellerFees', () => {
  const NO_DEAL = {
    mdr_bps_override: null,
    reserve_bps_override: null,
    commission_bps_override: null,
  };

  it('quotes the commission a paid-in-full order is actually charged', () => {
    // The constant `checkout` stamps onto every full order's `commission_bps`.
    expect(sellerFees(NO_DEAL).pay_now_commission_bps).toBe(DEFAULT_MARKETPLACE_COMMISSION_BPS);
    expect(sellerFees(NO_DEAL).pay_now_commission_bps).toBe(500);
  });

  it("quotes each plan type's own rates when nothing was negotiated", () => {
    const fees = sellerFees(NO_DEAL);
    expect(fees.plans).toEqual({
      bnpl: { mdr_bps: 400, reserve_bps: 500 },
      layaway: { mdr_bps: 300, reserve_bps: 200 },
      hybrid: { mdr_bps: 400, reserve_bps: 700 },
      rent_to_own: { mdr_bps: 500, reserve_bps: 1200 },
    });
    expect(fees.mdr_negotiated).toBe(false);
    expect(fees.reserve_negotiated).toBe(false);
  });

  it('quotes one flat MDR across every plan for a merchant with a deal', () => {
    const fees = sellerFees({ ...NO_DEAL, mdr_bps_override: 250 });
    expect(Object.values(fees.plans).map((p) => p.mdr_bps)).toEqual([250, 250, 250, 250]);
    // The reserve was not part of the deal, so it still follows the plan.
    expect(Object.values(fees.plans).map((p) => p.reserve_bps)).toEqual([500, 200, 700, 1200]);
    expect(fees.mdr_negotiated).toBe(true);
    expect(fees.reserve_negotiated).toBe(false);
  });

  it('keeps the pay-now commission apart from a negotiated MDR', () => {
    // The MDR prices Ejua fronting the money on a plan; the commission is the
    // marketplace's cut of a cash sale. A deal on one says nothing about the other.
    const fees = sellerFees({ ...NO_DEAL, mdr_bps_override: 250, reserve_bps_override: 0 });
    expect(fees.pay_now_commission_bps).toBe(500);
    expect(fees.commission_negotiated).toBe(false);
  });

  it('quotes a negotiated pay-now commission, which is what checkout stamps', () => {
    const fees = sellerFees({ ...NO_DEAL, commission_bps_override: 300 });
    expect(fees.pay_now_commission_bps).toBe(300);
    expect(fees.commission_negotiated).toBe(true);
    // The instalment side is untouched by a commission deal.
    expect(fees.plans.bnpl.mdr_bps).toBe(400);
  });
});
