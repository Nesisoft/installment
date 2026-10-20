import type { BusinessModel } from '@installment/api-types';
import { modelLabel } from './fees';

/**
 * Who carries the loss when a plan's customer stops paying for good.
 *
 * The app said "Ejua carries the risk" in six places, and that a missed payment
 * never claws back what was credited. `DefaultService`, which a collections
 * write-off runs, does something narrower. The loss is the part of the order
 * the merchant was credited for that the customer had not paid. The plan's
 * withheld reserve covers it first, for every model. Past the reserve, Ejua's
 * default pool takes the rest on BNPL, and the merchant's payable takes it on
 * hybrid and rent to own: their future payouts shrink until it clears. Those
 * two models share the risk, which is why they withhold 7% and 12% rather than
 * 5%. A seller deciding whether to offer them should read that before the sale,
 * not on a statement afterwards.
 *
 * A late payment on its own moves nothing. Only the write-off at the end of
 * collections does.
 */
export function sharesDefaultLoss(model: BusinessModel): boolean {
  return model === 'hybrid' || model === 'rent_to_own';
}

const LATE = 'A late payment takes nothing back from you.';

/** What a customer who stops paying would cost the seller on one plan. */
export function defaultRiskSentence(model: BusinessModel): string {
  if (model === 'layaway') {
    // Nothing accrues before completion, so a default has no settlement footprint.
    return 'On layaway nothing is credited to you until the customer has paid in full, so a customer who stops paying takes nothing back from you.';
  }
  if (!sharesDefaultLoss(model)) {
    return `${LATE} If the customer stops paying for good, this plan's reserve covers the loss first and Ejua carries the rest — what has been credited to you stays yours.`;
  }
  return `${LATE} If the customer stops paying for good, the part of the order you were credited for that they had not paid is covered by this plan's reserve first, and anything beyond it comes off your future payouts. ${modelLabel(model)} plans share that risk with you, which is why their reserve is larger.`;
}

/** The same, for a screen that covers every plan type at once. */
export const DEFAULT_RISK_SUMMARY = `${LATE} If a customer stops paying for good, the plan's reserve covers the loss first. On BNPL Ejua carries the rest; on hybrid and rent to own plans, the rest comes off your future payouts.`;
