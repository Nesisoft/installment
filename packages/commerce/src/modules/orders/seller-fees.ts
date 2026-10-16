import { MODEL_CONFIG, effectiveRates, type BusinessModel } from '@installment/core';
import { payNowCommissionBps } from './orders.service';

/** One plan type's cost to the seller, in basis points of the sale. */
export interface PlanFees {
  mdr_bps: number;
  reserve_bps: number;
}

/**
 * What a sale costs this seller — computed from the rules that charge it, so
 * the app never re-derives them.
 *
 * Two different fees, because two different things happen:
 *
 * - **Paid in full.** `checkout` stamps the marketplace commission — this
 *   merchant's deal, else the platform default — on the order, and
 *   `confirmPayment` books it. No reserve.
 * - **On a plan.** Activation freezes `effectiveRates` onto the plan: the
 *   merchant's negotiated rate if there is one, else the plan's business-model
 *   rate. Which plan applies is the buyer's choice at checkout, so the seller is
 *   given every model's figure rather than one number that is right for some
 *   sales only.
 *
 * `merchants.default_mdr_bps` / `default_reserve_bps` appear nowhere here:
 * since migration 0009 nothing charges them, and every fee the seller's app
 * showed was read from them.
 */
export interface SellerFees {
  pay_now_commission_bps: number;
  plans: Record<BusinessModel, PlanFees>;
  /** A deal on the MDR: every plan then charges the same rate. */
  mdr_negotiated: boolean;
  reserve_negotiated: boolean;
  /** A deal on the pay-now commission. Independent of the MDR. */
  commission_negotiated: boolean;
}

export function sellerFees(merchant: {
  mdr_bps_override: number | null;
  reserve_bps_override: number | null;
  commission_bps_override: number | null;
}): SellerFees {
  const negotiated = {
    mdrBpsOverride: merchant.mdr_bps_override,
    reserveBpsOverride: merchant.reserve_bps_override,
  };
  const plans = {} as Record<BusinessModel, PlanFees>;
  for (const model of Object.keys(MODEL_CONFIG) as BusinessModel[]) {
    const { mdrBps, reserveBps } = effectiveRates(model, negotiated);
    plans[model] = { mdr_bps: mdrBps, reserve_bps: reserveBps };
  }
  return {
    pay_now_commission_bps: payNowCommissionBps(merchant.commission_bps_override),
    plans,
    mdr_negotiated: merchant.mdr_bps_override !== null,
    reserve_negotiated: merchant.reserve_bps_override !== null,
    commission_negotiated: merchant.commission_bps_override !== null,
  };
}
