/**
 * Money and number formatting, in one place.
 *
 * Every amount crossing the API is an integer in pesewas (GHS x 100). Nothing
 * in the app divides by 100 inline — a screen that formats its own money is a
 * screen that will eventually round differently from the one next to it.
 *
 * The default here shows pesewas, which is the opposite of the shopper app.
 * A shopper is deciding whether to buy and reads a price; a seller is
 * reconciling what landed in their account, and `GHS 906` where the payout was
 * `GHS 905.60` is a number they cannot match against their MoMo statement.
 * Every money figure in the seller canvas carries two decimals.
 */

/** `120000` → `GHS 1,200.00`. The default: a seller's money is exact. */
export function ghs(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return '—';
  return `GHS ${cedis(pesewas)}`;
}

/** Bare number, no currency — for a figure that already sits beside a "GHS" label. */
export function cedis(pesewas: number): string {
  return (pesewas / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** `4321` → `4.3k`. Keeps a "6.4k sold" chip from wrapping. */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * A percentage change as the design prints it: `18` → `+18%`, `-4.2` → `−4.2%`,
 * `null` → `null`.
 *
 * `null` in, `null` out, on purpose. The API returns `null` where the previous
 * period was zero, because there is no percentage change from nothing — and a
 * caller that rendered that as "+0%" or "—%" would be inventing a comparison.
 * Callers are expected to drop the label entirely.
 *
 * The minus is U+2212, not a hyphen: at Outfit's weights a hyphen next to a
 * digit reads as a dash in the copy rather than a sign.
 */
export function signedPct(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined) return null;
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) return 'level';
  const body = `${Math.abs(rounded)}%`;
  return rounded > 0 ? `+${body}` : `−${body}`;
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A Ghana number as the design prints it: `+233240000002` → `024 000 0002`. */
export function phoneLocal(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('233') ? `0${digits.slice(3)}` : digits;
  if (local.length !== 10) return phone;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

/** Initials for an avatar tile: "Adepa Couture" → "AC"; one word → its first two. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
