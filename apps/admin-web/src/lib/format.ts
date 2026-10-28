const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An API date as a Date, or null.
 *
 * `timestamptz` values arrive as `2026-08-28 11:51:27.239902+00` — a space for
 * the `T`, microseconds, a two-digit offset. `new Date()` on that is
 * implementation-defined: Chrome accepts it, Safari answers Invalid Date, and
 * every date in the console read "—" there. Rewritten into the standard format
 * first, as customer-web's and the mobile apps' `parseApiDate` do. A plain
 * `YYYY-MM-DD` due date is read as local noon, so no timezone moves its day.
 */
export function parseApiDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y!, m! - 1, d!, 12, 0, 0);
  }
  const iso = value
    .replace(' ', 'T')
    .replace(/\.(\d+)/, (_match, fraction: string) => `.${fraction.slice(0, 3).padEnd(3, '0')}`)
    .replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value: string | null | undefined): string {
  const d = parseApiDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-GH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  const d = parseApiDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-GH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 days" / "5 hours" / "just now" — how long something has been waiting. */
export function waitingFor(value: string | null | undefined, now: Date = new Date()): string {
  const d = parseApiDate(value);
  if (!d) return '—';
  const minutes = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

export function formatPercent(rate: number | null | undefined, decimals = 1): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(decimals)}%`;
}
