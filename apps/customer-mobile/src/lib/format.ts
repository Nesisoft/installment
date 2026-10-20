/**
 * Money and number formatting, in one place.
 *
 * Every amount crossing the API is an integer in pesewas (GHS x 100). Nothing
 * in the app divides by 100 inline — a screen that formats its own money is a
 * screen that will eventually round differently from the one next to it.
 */

/** Thousands separators by hand: Hermes' `toLocaleString` grouping is not something to bet a price on. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function split(pesewas: number): { sign: string; whole: string; fraction: number } {
  const abs = Math.abs(Math.trunc(pesewas));
  return {
    sign: pesewas < 0 ? '-' : '',
    whole: grouped(Math.trunc(abs / 100)),
    fraction: abs % 100,
  };
}

/**
 * `28990000` → `GHS 289,900`; `77875` → `GHS 778.75`.
 *
 * Whole cedis when the amount is whole, the pesewas when it is not. This
 * rounded to whole cedis always, on the screens where a customer approves a
 * charge: "Pay GHS 779" above a Mobile Money prompt for GHS 778.75, a 40-pesewa
 * late fee shown as "GHS 0". The amount on a pay button is the amount charged.
 */
export function ghs(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return '—';
  const { sign, whole, fraction } = split(pesewas);
  return `${sign}GHS ${whole}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

/** `28990050` → `GHS 289,900.50`. Always two places — receipts and statements. */
export function ghsExact(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return '—';
  const { sign, whole, fraction } = split(pesewas);
  return `${sign}GHS ${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Bare number, no currency — for a figure that already sits beside a "GHS" label. */
export function cedis(pesewas: number): string {
  return Math.round(pesewas / 100).toLocaleString('en-GB');
}

/** `4321` → `4.3k`. Keeps a "6.4k sold" chip from wrapping. */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * How often instalments fall, in words.
 *
 * The design says "each Friday"; the engine schedules on a day interval with no
 * weekday anchoring, so a plan started on a Tuesday falls due on Tuesdays. This
 * says what is true.
 */
export function cadence(frequencyDays: number): string {
  if (frequencyDays === 7) return 'weekly';
  if (frequencyDays === 14) return 'fortnightly';
  if (frequencyDays === 28 || frequencyDays === 30 || frequencyDays === 31) return 'monthly';
  return `every ${frequencyDays} days`;
}

/** The noun form: "3 weekly payments" vs "every 10 days". */
export function cadenceNoun(frequencyDays: number): string {
  if (frequencyDays === 7) return 'week';
  if (frequencyDays === 14) return '2 weeks';
  if (frequencyDays === 28 || frequencyDays === 30 || frequencyDays === 31) return 'month';
  return `${frequencyDays} days`;
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A Ghana number as the design prints it: `+233240000002` → `+233 24 000 0002`. */
export function phoneDisplay(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('233') ? digits.slice(3) : digits.replace(/^0/, '');
  if (local.length !== 9) return phone;
  return `+233 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
}

/** Everything the API accepts as a phone, normalised to what it stores. */
export function phoneE164(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('233')) return `+${digits}`;
  return `+233${digits.replace(/^0/, '')}`;
}

/** Initials for an avatar tile: "Ama Boateng" → "AB". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
