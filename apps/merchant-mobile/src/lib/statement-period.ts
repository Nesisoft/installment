/**
 * The month a statement covers, as plain functions so the stepping rules can be
 * tested in node. Months are calendar months in UTC, which is what the API's
 * `/merchant/statement?year=&month=` reads.
 */

export interface StatementPeriod {
  year: number;
  /** 1–12. */
  month: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The month `now` falls in. */
export function currentPeriod(now: Date = new Date()): StatementPeriod {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** The month before or after, across year boundaries. */
export function stepPeriod(period: StatementPeriod, by: -1 | 1): StatementPeriod {
  const index = period.year * 12 + (period.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * Whether there is a month after this one to show. There is no statement for a
 * month that has not started, so stepping stops at the current one.
 */
export function hasNextPeriod(period: StatementPeriod, now: Date = new Date()): boolean {
  const current = currentPeriod(now);
  return period.year * 12 + period.month < current.year * 12 + current.month;
}

/** "November 2026". */
export function periodLabel(period: StatementPeriod): string {
  return `${MONTHS[period.month - 1]} ${period.year}`;
}

/** "2026-11", for file names. */
export function periodSlug(period: StatementPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}
