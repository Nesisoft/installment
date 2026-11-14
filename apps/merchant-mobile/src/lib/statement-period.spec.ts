import { describe, expect, it } from 'vitest';
import {
  currentPeriod,
  hasNextPeriod,
  periodLabel,
  periodSlug,
  stepPeriod,
} from './statement-period';

const NOW = new Date('2026-11-14T10:00:00Z');

describe('statement periods', () => {
  it('starts on the month it is now, in UTC', () => {
    expect(currentPeriod(NOW)).toEqual({ year: 2026, month: 11 });
    // Late on the last evening of a month in UTC+0 is still that month.
    expect(currentPeriod(new Date('2026-11-30T23:59:59Z'))).toEqual({ year: 2026, month: 11 });
  });

  it('steps across the year boundary both ways', () => {
    expect(stepPeriod({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(stepPeriod({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
    expect(stepPeriod({ year: 2026, month: 6 }, 1)).toEqual({ year: 2026, month: 7 });
  });

  it('stops at the current month: there is no statement for one not yet started', () => {
    expect(hasNextPeriod({ year: 2026, month: 11 }, NOW)).toBe(false);
    expect(hasNextPeriod({ year: 2026, month: 10 }, NOW)).toBe(true);
    expect(hasNextPeriod({ year: 2025, month: 12 }, NOW)).toBe(true);
  });

  it('labels and names files the way a seller reads them', () => {
    expect(periodLabel({ year: 2026, month: 3 })).toBe('March 2026');
    expect(periodSlug({ year: 2026, month: 3 })).toBe('2026-03');
  });
});
