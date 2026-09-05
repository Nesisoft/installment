import { describe, expect, it } from 'vitest';
import type { MerchantStatsDay } from '@installment/api-types';
import { lastDays, latestDay, shortDay, shortWeekday, vsSameWeekday } from './today';

/** `n` consecutive days ending 2026-09-03 (a Thursday), with the given values. */
function series(values: number[]): MerchantStatsDay[] {
  const end = Date.UTC(2026, 8, 3);
  return values.map((grossSoldPesewas, i) => ({
    date: new Date(end - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    orders: grossSoldPesewas === 0 ? 0 : 1,
    grossSoldPesewas,
  }));
}

describe('latestDay', () => {
  it('returns the last row, dated from the row rather than from the clock', () => {
    expect(latestDay(series([100, 200, 300]))).toEqual({
      date: '2026-09-03',
      grossSoldPesewas: 300,
      orders: 1,
    });
  });

  it('is null for an empty window rather than a zero it cannot vouch for', () => {
    expect(latestDay([])).toBeNull();
  });
});

describe('vsSameWeekday', () => {
  it('compares today with the same weekday a week ago', () => {
    // Eight days ending Thu 3 Sep 2026, so index 0 is Thu 27 Aug — the same
    // weekday, which is the whole point of reaching back eight rows and not two.
    const daily = series([1000, 0, 0, 0, 0, 0, 0, 1180]);
    expect(vsSameWeekday(daily)).toEqual({ pct: 18, weekday: 'Thu' });
  });

  it('reports a fall as a negative', () => {
    const daily = series([1000, 0, 0, 0, 0, 0, 0, 800]);
    expect(vsSameWeekday(daily)?.pct).toBe(-20);
  });

  it('is null when the comparison day sold nothing — there is no change from zero', () => {
    expect(vsSameWeekday(series([0, 0, 0, 0, 0, 0, 0, 500]))).toBeNull();
  });

  it('is null when the window is too short to reach back a week', () => {
    // A 7-day window has no eighth day, which is why the screen asks for 30.
    expect(vsSameWeekday(series([1, 2, 3, 4, 5, 6, 7]))).toBeNull();
  });

  it('is null for an empty window', () => {
    expect(vsSameWeekday([])).toBeNull();
  });
});

describe('lastDays', () => {
  it('takes the tail', () => {
    expect(lastDays(series([1, 2, 3, 4, 5]), 2).map((d) => d.grossSoldPesewas)).toEqual([4, 5]);
  });

  it('returns everything it has rather than padding a short history', () => {
    expect(lastDays(series([1, 2]), 14)).toHaveLength(2);
  });
});

describe('date labels', () => {
  it('reads a date key as UTC, not as local midnight', () => {
    expect(shortWeekday('2026-09-03')).toBe('Thu');
    expect(shortDay('2026-09-03')).toBe('3 Sep');
  });

  it('does not throw on a malformed key', () => {
    expect(shortWeekday('not-a-date')).toBe('');
    expect(shortDay('not-a-date')).toBe('not-a-date');
  });
});
