import { describe, expect, it } from 'vitest';
import { formatDate, parseApiDate, waitingFor } from './format';

describe('parseApiDate', () => {
  it('reads the Postgres timestamptz shape the API sends', () => {
    // Safari's `new Date()` answers Invalid Date for exactly this string.
    const d = parseApiDate('2026-08-28 11:51:27.239902+00');
    expect(d?.toISOString()).toBe('2026-08-28T11:51:27.239Z');
  });

  it('reads a non-zero offset and a plain ISO string', () => {
    expect(parseApiDate('2026-08-28 13:51:27+02')?.toISOString()).toBe('2026-08-28T11:51:27.000Z');
    expect(parseApiDate('2026-08-28T11:51:27.000Z')?.toISOString()).toBe(
      '2026-08-28T11:51:27.000Z',
    );
  });

  it('reads a due date as that calendar day wherever the console is opened', () => {
    const d = parseApiDate('2026-11-03')!;
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 11, 3]);
  });

  it('answers null, not Invalid Date, for nothing or nonsense', () => {
    expect(parseApiDate(null)).toBeNull();
    expect(parseApiDate('')).toBeNull();
    expect(parseApiDate('not a date')).toBeNull();
    expect(formatDate('not a date')).toBe('—');
  });
});

describe('waitingFor', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  it('says how long, in the unit a person would use', () => {
    expect(waitingFor('2026-10-28 11:59:40+00', now)).toBe('just now');
    expect(waitingFor('2026-10-28 11:15:00+00', now)).toBe('45 min');
    expect(waitingFor('2026-10-28 11:00:00+00', now)).toBe('1 hour');
    expect(waitingFor('2026-10-27 00:00:00+00', now)).toBe('36 hours');
    expect(waitingFor('2026-10-21 12:00:00+00', now)).toBe('7 days');
  });
});
