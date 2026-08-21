/**
 * Cart lines carry only `variant_id` + price — the API has no public
 * variant→product lookup, so a cart alone cannot show product names. We
 * remember the label when the item is added from a product page and fall back
 * gracefully (e.g. a cart built on another device) until the API denormalises
 * a title onto the line.
 */
const KEY = 'installment.customer.variantLabels';

export interface VariantLabel {
  title: string;
  productId: string;
}

type LabelMap = Record<string, VariantLabel>;

function read(): LabelMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LabelMap) : {};
  } catch {
    return {};
  }
}

export function rememberVariant(variantId: string, label: VariantLabel): void {
  try {
    const map = read();
    map[variantId] = label;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage disabled — labels just fall back */
  }
}

export function variantLabel(variantId: string): VariantLabel | null {
  return read()[variantId] ?? null;
}
