import type { MerchantStatsDay } from '@installment/api-types';
import { dayMonth, weekdayShort } from './dates';

/**
 * Derivations for the home screen's hero, kept out of the component so they can
 * be tested without a renderer.
 *
 * Every one of them reads `MerchantStats.daily`, which the API fills for every
 * day in the window including the ones that sold nothing. That guarantee is
 * what makes indexing backwards by position safe here — `daily[n - 8]` really
 * is a week before `daily[n - 1]`, not "eight rows ago, whenever those were".
 */

export interface TodayLine {
  /** The day the figure is for, `YYYY-MM-DD`. */
  date: string;
  grossSoldPesewas: number;
  orders: number;
}

/**
 * The last day in the window.
 *
 * The API builds the window so that it ends with today, so this is today — but
 * it returns the row's own date rather than asserting that, because a client
 * that had cached the response overnight would otherwise label yesterday's
 * money "SOLD TODAY". The screen prints the returned date.
 */
export function latestDay(daily: MerchantStatsDay[]): TodayLine | null {
  const last = daily[daily.length - 1];
  if (!last) return null;
  return { date: last.date, grossSoldPesewas: last.grossSoldPesewas, orders: last.orders };
}

/**
 * Today against the same weekday a week ago — the design's "+18% vs last Thu".
 *
 * A weekday comparison rather than yesterday, because retail weeks are not
 * flat: a Ghanaian shop's Saturday against its Friday says more about the
 * calendar than about the shop. Needs eight days of window, so the caller must
 * ask for 30, not 7.
 *
 * `null` when there is no comparable day, or when that day sold nothing. There
 * is no percentage change from zero, and "+∞%" or "+100%" would both be a claim
 * the numbers do not support.
 */
export function vsSameWeekday(daily: MerchantStatsDay[]): { pct: number; weekday: string } | null {
  const n = daily.length;
  const today = daily[n - 1];
  const weekAgo = daily[n - 8];
  if (!today || !weekAgo || weekAgo.grossSoldPesewas === 0) return null;
  const pct =
    ((today.grossSoldPesewas - weekAgo.grossSoldPesewas) / weekAgo.grossSoldPesewas) * 100;
  return { pct: Math.round(pct * 10) / 10, weekday: shortWeekday(weekAgo.date) };
}

/**
 * `2026-09-03` → `Thu`, and → `3 Sep`.
 *
 * Both go through `parseApiDate`, which reads a bare date key as LOCAL NOON —
 * so the calendar day survives a device west of UTC, where UTC midnight is the
 * previous evening. Ghana is UTC+0 and would not notice; a seller travelling
 * would, and a chart axis labelled a day out is a chart that argues with the
 * figure above it.
 */
export function shortWeekday(dateKey: string): string {
  return weekdayShort(dateKey);
}

export function shortDay(dateKey: string): string {
  const label = dayMonth(dateKey);
  // `dayMonth` returns an em dash for an unparseable value; the axis is better
  // off echoing the key than printing a dash where a date should be.
  return label === '—' ? dateKey : label;
}

/**
 * The last `count` days, for the hero's bars.
 *
 * Returns fewer than asked for rather than padding: a shop three days old has
 * three days of history, and eleven empty bars in front of them would draw a
 * collapse that never happened.
 */
export function lastDays(daily: MerchantStatsDay[], count: number): MerchantStatsDay[] {
  return count >= daily.length ? daily : daily.slice(daily.length - count);
}
