/**
 * Date handling for API values.
 *
 * There is a trap here worth stating plainly. The API's `timestamptz` columns
 * are declared `mode: 'string'`, but `node-postgres` parses them into a JS Date
 * first, so Drizzle re-serialises them as `"2026-08-28 11:51:27.239902+00"` — a
 * SPACE separator, a two-digit offset, no `T` and no `Z`. `new Date()` on that
 * string is implementation-defined, and Hermes (React Native's engine) returns
 * `Invalid Date`. Every API timestamp therefore goes through `parseApiDate`,
 * and nothing else in the app calls `new Date()` on an API string.
 *
 * Plain `YYYY-MM-DD` due dates are a second trap: parsed as-is they become UTC
 * midnight, and a device west of UTC renders the previous day. Ghana is UTC+0
 * so it does not bite locally, but a customer in Lagos or London would see the
 * wrong due date, so they are parsed as local noon.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseApiDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    // Local noon: far enough from either midnight that no timezone shifts the day.
    return new Date(y!, m! - 1, d!, 12, 0, 0);
  }

  const normalised = value
    .replace(' ', 'T')
    // "+00" → "+00:00"; Date.parse rejects a bare two-digit offset.
    .replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Fri 29 Aug` — the design's due-date format. */
export function shortDate(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  if (!d) return '—';
  return `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/** `29 Aug 2026` — where the year matters (history, receipts). */
export function longDate(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  if (!d) return '—';
  return `${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`;
}

/** `27 Aug · 9:14 am` — for a tracking timeline entry. */
export function dateTime(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  if (!d) return '—';
  const hours = d.getHours();
  const suffix = hours < 12 ? 'am' : 'pm';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${d.getDate()} ${MONTH[d.getMonth()]} · ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

/** `Today`, `Tomorrow`, `Fri 29 Aug` — how the design labels a due date. */
export function relativeDate(value: string | Date | null | undefined, now = new Date()): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  if (!d) return '—';
  const days = daysBetween(now, d);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
  return shortDate(d);
}

/** Whole days from `a` to `b`, comparing calendar days rather than elapsed time. */
export function daysBetween(a: Date, b: Date): number {
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((end - start) / 86_400_000);
}

/** `04:12:56` — the flash-deal countdown. Empty once the deal has ended. */
export function countdown(target: string | Date | null | undefined, now = new Date()): string {
  const d = target instanceof Date ? target : parseApiDate(target);
  if (!d) return '';
  const remaining = Math.floor((d.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(remaining / 3600))}:${pad(Math.floor(remaining / 60) % 60)}:${pad(remaining % 60)}`;
}

/** `Arrives Tue 1 Sep – Thu 3 Sep`, or a single day when the window is one day. */
export function arrivalWindow(earliest: string, latest: string): string {
  if (earliest === latest) return `Arrives ${shortDate(earliest)}`;
  return `Arrives ${shortDate(earliest)} – ${shortDate(latest)}`;
}
