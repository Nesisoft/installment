/**
 * Stock-keeping codes, since the schema requires one and the seller is never
 * asked for it.
 *
 * Unique per product (`product_variants` is UNIQUE on `(product_id, sku)`), not
 * globally — so the title and the option value are enough to read, and two
 * shops selling "Ankara Wrap Dress · M" do not collide.
 *
 * This used to be `slug(title + '-' + value).slice(0, 64)`. The slice cut from
 * the end, which is where the value is: a title of 63 characters or more gave
 * every size the same code, and the listing was refused with a 409 naming a SKU
 * the seller had never seen. A value with no Latin letters or digits in it —
 * "ɔ", "大" — slugged to nothing, with the same result. Here the title is what
 * gets shortened, and anything still equal is numbered.
 */
const SKU_MAX = 64;

/** Upper-case Latin letters and digits, joined by single dashes. */
function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `head-tail`, shortening `head` so the whole fits the column. */
function fit(head: string, tail: string): string {
  const room = SKU_MAX - tail.length - 1;
  if (room <= 0) return tail.slice(0, SKU_MAX);
  return `${head.slice(0, room).replace(/-+$/, '')}-${tail}`;
}

/**
 * A code for each of `values`, in order: distinct from one another and from
 * every code in `taken` (the product's existing variants, when adding one).
 */
export function skusFor(
  title: string,
  values: readonly string[],
  taken: Iterable<string> = [],
): string[] {
  const used = new Set(taken);
  const head = slug(title) || 'ITEM';
  return values.map((value) => {
    const tail = slug(value) || 'OPTION';
    let sku = fit(head, tail);
    for (let n = 2; used.has(sku); n += 1) sku = fit(head, `${tail}-${n}`);
    used.add(sku);
    return sku;
  });
}
