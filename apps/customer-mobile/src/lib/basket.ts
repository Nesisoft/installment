import type { PlanQuote } from '@installment/api-types';
import { cadence, ghs } from './format';

export interface BasketCost {
  /** Null while the delivery fee is not known — never shown as "Free". */
  deliveryPesewas: number | null;
  totalPesewas: number | null;
}

/**
 * What a basket will cost, as the server charges it.
 *
 * Checkout makes one order per shop, and each order carries its own delivery
 * fee: a two-shop basket at GHS 15 delivery is GHS 30 of delivery, and the
 * screen added GHS 15 once — the order total read GHS 3,115 for orders that
 * came to GHS 3,130. And a fee still loading, or one that failed to load,
 * counted as zero, so the basket read "Delivery: Free" and a total short by
 * the fee on the screen where the customer commits.
 */
export function basketCost(input: {
  subtotalPesewas: number;
  storeCount: number;
  pickup: boolean;
  /** The per-order courier fee, undefined until it has loaded. */
  feePesewas: number | undefined;
}): BasketCost {
  if (input.pickup) {
    return { deliveryPesewas: 0, totalPesewas: input.subtotalPesewas };
  }
  if (input.feePesewas === undefined) return { deliveryPesewas: null, totalPesewas: null };
  const deliveryPesewas = input.feePesewas * Math.max(1, input.storeCount);
  return { deliveryPesewas, totalPesewas: input.subtotalPesewas + deliveryPesewas };
}

type QuoteTerms = Pick<
  PlanQuote,
  | 'down_payment_pesewas'
  | 'number_of_installments'
  | 'per_installment_pesewas'
  | 'installment_frequency_days'
  | 'installments'
>;

/**
 * A plan in one line and its follow-up, deposit or not.
 *
 * With no deposit this read "Pay GHS 0 today, then 4 × …". The count after
 * "then" is `number_of_installments`, which excludes the deposit; with no
 * deposit every payment is in `installments`.
 */
export function planLines(q: QuoteTerms): { lead: string; rest: string } {
  const every = cadence(q.installment_frequency_days);
  if (q.down_payment_pesewas > 0) {
    return {
      lead: `Pay ${ghs(q.down_payment_pesewas)} today`,
      rest: `then ${q.number_of_installments} × ${ghs(q.per_installment_pesewas)} ${every}`,
    };
  }
  const n = q.installments.length;
  return {
    lead: `Pay in ${n}`,
    rest: `${n} × ${ghs(q.per_installment_pesewas)} ${every}, nothing today`,
  };
}
