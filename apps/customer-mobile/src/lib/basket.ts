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

/** One shop's share of the basket: the order checkout will make for it. */
export interface ShopOrder {
  storeId: string;
  name: string;
  subtotalPesewas: number;
  /** Subtotal plus this order's own delivery; null while delivery is unpriced. */
  amountPesewas: number | null;
}

interface ShopLine {
  store_id: string | null;
  store_display_name: string | null;
  line_total_pesewas: number;
}

/**
 * The basket as the orders checkout will create — one per shop, each with its
 * own delivery fee — so a plan can be quoted against what each order will be.
 */
export function shopOrders(
  lines: readonly ShopLine[],
  delivery: { pickup: boolean; feePesewas: number | undefined },
): ShopOrder[] {
  const byStore = new Map<string, ShopOrder>();
  for (const line of lines) {
    const storeId = line.store_id ?? 'unknown';
    const shop = byStore.get(storeId) ?? {
      storeId,
      name: line.store_display_name ?? 'Other items',
      subtotalPesewas: 0,
      amountPesewas: null,
    };
    shop.subtotalPesewas += line.line_total_pesewas;
    byStore.set(storeId, shop);
  }
  const fee = delivery.pickup ? 0 : delivery.feePesewas;
  return [...byStore.values()].map((shop) => ({
    ...shop,
    amountPesewas: fee === undefined ? null : shop.subtotalPesewas + fee,
  }));
}

/**
 * The plan templates every shop's order qualifies for, in the first shop's
 * order — checkout sends one template for all of them. Null until every
 * shop's quote has loaded.
 */
export function commonEligibleTemplateIds(
  quotesPerShop: readonly (
    | readonly Pick<PlanQuote, 'plan_template_id' | 'eligible'>[]
    | undefined
  )[],
): string[] | null {
  if (quotesPerShop.length === 0 || quotesPerShop.some((q) => q === undefined)) return null;
  const [first, ...rest] = quotesPerShop as readonly (readonly Pick<
    PlanQuote,
    'plan_template_id' | 'eligible'
  >[])[];
  return first!
    .filter((q) => q.eligible)
    .map((q) => q.plan_template_id)
    .filter((id) =>
      rest.every((shop) => shop.some((q) => q.plan_template_id === id && q.eligible)),
    );
}

type ShopQuote = Pick<PlanQuote, 'plan_template_id' | 'eligible' | 'per_installment_pesewas'>;

/**
 * Each shop's plan on the template with the smallest instalments, among those
 * every shop's order qualifies for — what "or pay …" offers, per order. Null
 * until every quote has loaded, or when no template fits them all.
 */
export function cheapestCommonPlans<Q extends ShopQuote>(
  quotesPerShop: readonly (readonly Q[] | undefined)[],
): Q[] | null {
  const ids = commonEligibleTemplateIds(quotesPerShop);
  if (!ids || ids.length === 0) return null;
  const plansFor = (id: string): Q[] =>
    quotesPerShop.map((shop) => shop!.find((q) => q.plan_template_id === id)!);
  const perInstalment = (plans: Q[]): number =>
    plans.reduce((sum, q) => sum + q.per_installment_pesewas, 0);
  return ids
    .map(plansFor)
    .reduce((best, plans) => (perInstalment(plans) < perInstalment(best) ? plans : best));
}

/**
 * One line, and its follow-up, for the plans a checkout will create.
 *
 * One order reads as its plan. Several are several schedules, none of which
 * describes the others, so they read as what is due today across them.
 */
export function ordersPlanLines(plans: readonly QuoteTerms[]): { lead: string; rest: string } {
  if (plans.length === 1) return planLines(plans[0]!);
  const deposit = plans.reduce((sum, q) => sum + q.down_payment_pesewas, 0);
  return {
    lead: deposit > 0 ? `Pay ${ghs(deposit)} today` : `Pay in ${plans[0]!.installments.length}`,
    rest: `${plans.length} orders, each on its own plan`,
  };
}

/**
 * Why a fully quoted basket has no plan to offer: names the shop whose order
 * no plan fits, with the plan's own reason, or says no single plan fits every
 * order. Shown in place of a plan, so the customer is not left with a disabled
 * button and no explanation.
 */
export function noPlanReason(
  shops: readonly { name: string }[],
  quotesPerShop: readonly (
    | readonly Pick<PlanQuote, 'eligible' | 'ineligible_reason'>[]
    | undefined
  )[],
): string {
  const blocked = shops.findIndex((_, i) => !(quotesPerShop[i] ?? []).some((q) => q.eligible));
  const reason =
    blocked >= 0
      ? (quotesPerShop[blocked]?.find((q) => q.ineligible_reason)?.ineligible_reason ?? null)
      : null;
  if (shops.length <= 1) {
    return reason
      ? `Instalments are not available for this order. ${reason}.`
      : 'Instalments are not available for this order.';
  }
  if (blocked >= 0) {
    const why = reason ? ` (${reason.charAt(0).toLowerCase()}${reason.slice(1)})` : '';
    return `Instalments are not available for this basket: no plan fits the ${shops[blocked]!.name} order${why}. Pay in full, or buy from that shop on its own.`;
  }
  return 'Instalments are not available for this basket: no one plan fits every shop’s order. Pay in full, or buy from one shop at a time.';
}
