const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An API date as a Date, or null.
 *
 * The API's `timestamptz` values arrive as `2026-08-28 11:51:27.239902+00` — a
 * space for the `T`, microseconds, a two-digit offset. That is not the one
 * shape every engine must parse, so `new Date()` on it is implementation-
 * defined: Chrome accepts it, others need not (Hermes, in the mobile app,
 * returns Invalid Date, and every date there read "—"). Rewritten into the
 * standard format first, as the mobile app's `parseApiDate` does. A plain
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
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 3 days" / "2 days overdue" / "today" for a due date, by calendar day. */
export function relativeDay(value: string | null | undefined, now: Date = new Date()): string {
  const then = parseApiDate(value);
  if (!then) return '';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(then) - startOf(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days overdue`;
}
