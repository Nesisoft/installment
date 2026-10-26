import type { CartLine, PlanQuote } from '@installment/api-types';

/** One shop's share of the basket: the order checkout will make for it. */
export interface ShopOrder {
  storeId: string;
  name: string;
  subtotalPesewas: number;
  /** Subtotal plus this order's own delivery; null while delivery is unpriced. */
  amountPesewas: number | null;
}

/**
 * The basket as the orders checkout will create — one per store, each with its
 * own delivery fee (`OrdersService.checkout` charges the quote per order). The
 * page charged delivery once and quoted one plan on the combined total: a
 * two-shop basket read GHS 480 where the orders came to GHS 495.
 */
export function shopOrders(
  lines: readonly Pick<CartLine, 'store_id' | 'store_display_name' | 'line_total_pesewas'>[],
  feePesewas: number | undefined,
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
  return [...byStore.values()].map((shop) => ({
    ...shop,
    amountPesewas: feePesewas === undefined ? null : shop.subtotalPesewas + feePesewas,
  }));
}

type QuoteEligibility = Pick<PlanQuote, 'plan_template_id' | 'eligible'>;

/**
 * The plan templates every shop's order qualifies for, in the first shop's
 * order — checkout sends one template for all of them, so a plan one order is
 * too small for would decline that order. Null until every shop is quoted.
 */
export function commonEligibleTemplateIds(
  quotesPerShop: readonly (readonly QuoteEligibility[] | undefined)[],
): string[] | null {
  if (quotesPerShop.length === 0 || quotesPerShop.some((q) => q === undefined)) return null;
  const [first, ...rest] = quotesPerShop as readonly (readonly QuoteEligibility[])[];
  return first!
    .filter((q) => q.eligible)
    .map((q) => q.plan_template_id)
    .filter((id) =>
      rest.every((shop) => shop.some((q) => q.plan_template_id === id && q.eligible)),
    );
}

/**
 * Why a fully quoted basket has no plan to offer: names the shop whose order no
 * plan fits, with the plan's own reason, or says no single plan fits every order.
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
      ? `Instalments are not available for this order. ${reason}. You can still pay in full.`
      : 'Instalments are not available for this order. You can still pay in full.';
  }
  if (blocked >= 0) {
    const why = reason ? ` (${reason.charAt(0).toLowerCase()}${reason.slice(1)})` : '';
    return `Instalments are not available for this basket: no plan fits the ${shops[blocked]!.name} order${why}. Pay in full, or buy from that shop on its own.`;
  }
  return 'Instalments are not available for this basket: no one plan fits every shop’s order. Pay in full, or buy from one shop at a time.';
}
