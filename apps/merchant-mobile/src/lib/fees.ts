import type { BusinessModel, SellerFees } from '@installment/api-types';

/**
 * What a sale leaves the seller.
 *
 * The rates come from the server (`GET /merchant/me` → `fees`), computed there
 * from the code that charges them; nothing here decides a rate. What is left
 * is turning a rate into pesewas, and that has to round the way the engine
 * books it or the preview and the payout disagree.
 *
 * Two kinds of sale, because two different things happen. Paid in full: the
 * marketplace commission, nothing held. On a plan: the MDR and reserve of the
 * plan the BUYER picks at checkout — so the seller sees each plan type their
 * item can be bought on, not one rate that is right for some sales only.
 */

/**
 * `bps` of an amount, half-up to a whole pesewa — `Money.multiplyBps`, which is
 * what books the fee. Exact for any price a till would see: the product stays
 * far inside 2^53.
 */
export function bpsShare(pesewas: number, bps: number): number {
  return Math.floor((pesewas * bps + 5_000) / 10_000);
}

/** `400` → `4%`, `250` → `2.5%`. */
export function pct(bps: number): string {
  return `${bps / 100}%`;
}

/** One figure when every value agrees, else a span: `[300, 500]` → `3–5%`. */
export function pctSpan(bps: readonly number[]): string {
  const lo = Math.min(...bps);
  const hi = Math.max(...bps);
  return lo === hi ? pct(lo) : `${lo / 100}–${pct(hi)}`;
}

const MODEL_ORDER: readonly BusinessModel[] = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'];

/** The admin console's names for the same four, so staff and seller say one thing. */
const MODEL_LABEL: Record<BusinessModel, string> = {
  bnpl: 'BNPL',
  layaway: 'Layaway',
  hybrid: 'Hybrid',
  rent_to_own: 'Rent to own',
};

export interface SaleSplit {
  key: 'pay_now' | BusinessModel;
  label: string;
  feeBps: number;
  reserveBps: number;
  fee: number;
  /** Held, not taken: it comes back once the buyer has finished paying. */
  reserve: number;
  net: number;
}

function split(
  key: SaleSplit['key'],
  label: string,
  price: number,
  feeBps: number,
  reserveBps: number,
): SaleSplit {
  const fee = bpsShare(price, feeBps);
  const reserve = bpsShare(price, reserveBps);
  return { key, label, feeBps, reserveBps, fee, reserve, net: price - fee - reserve };
}

/**
 * A sale at `price`: paid in full first, then once per plan type in `models`
 * (the business models of the plans the item can be sold on), in a fixed order.
 *
 * To the pesewa for every plan type but one: a hybrid plan pays out in two
 * slices, each rounded on its own, so its real fee can land a pesewa away from
 * this single-slice figure.
 */
export function saleSplits(
  price: number,
  fees: SellerFees,
  models: readonly BusinessModel[],
): SaleSplit[] {
  const out = [split('pay_now', 'Paid in full', price, fees.pay_now_commission_bps, 0)];
  for (const model of MODEL_ORDER) {
    if (!models.includes(model)) continue;
    const rates = fees.plans[model];
    out.push(split(model, MODEL_LABEL[model], price, rates.mdr_bps, rates.reserve_bps));
  }
  return out;
}

/** The fee in one sentence, for a screen with no sale in front of it. */
export function feeSentence(fees: SellerFees): string {
  const mdr = Object.values(fees.plans).map((p) => p.mdr_bps);
  const onPlans =
    Math.min(...mdr) === Math.max(...mdr)
      ? `${pctSpan(mdr)} on every instalment sale`
      : `${pctSpan(mdr)} on an instalment sale depending on the plan the buyer picks`;
  return `Ejua's fee is ${pct(fees.pay_now_commission_bps)} on a paid-in-full order, and ${onPlans}.`;
}
