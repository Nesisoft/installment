import { describe, expect, it } from 'vitest';
import { parseApiDate, relativeDay } from './format';

describe('parseApiDate', () => {
  it('reads the timestamp shape the API actually sends', () => {
    // Space separator, microseconds, bare two-digit offset.
    expect(parseApiDate('2026-08-28 11:51:27.239902+00')?.toISOString()).toBe(
      '2026-08-28T11:51:27.239Z',
    );
    expect(parseApiDate('2026-08-28 11:51:27+00')?.toISOString()).toBe('2026-08-28T11:51:27.000Z');
  });

  it('reads a due date as that calendar day, wherever the browser is', () => {
    const d = parseApiDate('2026-10-30')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 30]);
  });

  it('gives null rather than an Invalid Date', () => {
    expect(parseApiDate('not a date')).toBeNull();
    expect(parseApiDate(null)).toBeNull();
  });
});

describe('relativeDay', () => {
  const now = new Date(2026, 9, 27, 23, 30);

  it('counts calendar days, not 24-hour spans', () => {
    expect(relativeDay('2026-10-28', now)).toBe('tomorrow');
    expect(relativeDay('2026-10-30', now)).toBe('in 3 days');
    expect(relativeDay('2026-10-25', now)).toBe('2 days overdue');
  });
});
