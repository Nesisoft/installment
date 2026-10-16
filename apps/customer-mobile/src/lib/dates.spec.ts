import { describe, expect, it } from 'vitest';
import {
  arrivalWindow,
  countdown,
  daysBetween,
  parseApiDate,
  toIsoDateTime,
  relativeDate,
  shortDate,
} from './dates';

/**
 * The string `parseApiDate` hands to `new Date()`.
 *
 * Asserted on the STRING, not the parsed Date, and that is deliberate. vitest
 * runs on V8, and V8 parses the raw API timestamp unaided — so the parse test
 * below passes against a `parseApiDate` that normalises nothing at all. It
 * guards a Hermes trap on an engine that does not have it.
 *
 * What does mean the same thing on every engine is whether the string is in
 * ECMA-262's Date Time String Format: a conformant engine must parse that
 * shape, and anything else is implementation-defined. Postgres emits
 * microseconds — six fractional digits — and the format specifies three.
 */
describe('toIsoDateTime', () => {
  const ECMA_262 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2})$/;

  it('produces ECMA-262 Date Time String Format for every shape the API emits', () => {
    for (const raw of [
      '2026-08-28 11:51:27.239902+00',
      '2026-08-28 11:51:27.483433+00',
      '2026-08-28 11:51:27.5+00',
      '2026-08-28 11:51:27+00',
      '2026-08-28 11:51:27.239902-05',
      '2026-08-28T11:51:27.000Z',
    ]) {
      expect(toIsoDateTime(raw)).toMatch(ECMA_262);
    }
  });

  it('truncates microseconds to the three digits the format allows', () => {
    expect(toIsoDateTime('2026-08-28 11:51:27.239902+00')).toBe('2026-08-28T11:51:27.239+00:00');
  });

  it('pads a short fraction rather than leaving it non-conformant', () => {
    expect(toIsoDateTime('2026-08-28 11:51:27.5+00')).toBe('2026-08-28T11:51:27.500+00:00');
  });

  it('leaves an already-conformant string alone', () => {
    expect(toIsoDateTime('2026-08-28T11:51:27.000Z')).toBe('2026-08-28T11:51:27.000Z');
  });
});

describe('parseApiDate', () => {
  it("parses the API's actual timestamp format", () => {
    // node-postgres + Drizzle emit a space separator and a 2-digit offset, which
    // Hermes reads as Invalid Date. This is the whole reason the helper exists.
    const d = parseApiDate('2026-08-28 11:51:27.239902+00');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-08-28T11:51:27.239Z');
  });

  it('still parses a well-formed ISO string', () => {
    expect(parseApiDate('2026-08-28T11:51:27.000Z')!.toISOString()).toBe(
      '2026-08-28T11:51:27.000Z',
    );
  });

  it('reads a bare due date as local noon, not UTC midnight', () => {
    // At UTC midnight a device west of UTC renders the previous day, which
    // would show a customer the wrong due date.
    const d = parseApiDate('2026-09-04')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(12);
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parseApiDate(null)).toBeNull();
    expect(parseApiDate('')).toBeNull();
    expect(parseApiDate('not a date')).toBeNull();
  });
});

describe('shortDate', () => {
  it('formats the way the schedule cards do', () => {
    expect(shortDate('2026-09-04')).toBe('Fri 4 Sep');
  });

  it('renders a dash for a missing value instead of crashing', () => {
    expect(shortDate(null)).toBe('—');
  });
});

describe('relativeDate', () => {
  const now = new Date(2026, 8, 4, 9, 0, 0);

  it('names the near days', () => {
    expect(relativeDate('2026-09-04', now)).toBe('Today');
    expect(relativeDate('2026-09-05', now)).toBe('Tomorrow');
    expect(relativeDate('2026-09-03', now)).toBe('Yesterday');
  });

  it('falls back to a date once it is far enough out', () => {
    expect(relativeDate('2026-09-25', now)).toBe('Fri 25 Sep');
  });
});

describe('daysBetween', () => {
  it('counts calendar days, not elapsed hours', () => {
    // 23:00 to 01:00 the next morning is two hours but one day.
    const a = new Date(2026, 8, 4, 23, 0, 0);
    const b = new Date(2026, 8, 5, 1, 0, 0);
    expect(daysBetween(a, b)).toBe(1);
  });
});

describe('countdown', () => {
  it('counts down to a deal ending', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    expect(countdown('2026-08-28 16:12:56+00', now)).toBe('04:12:56');
  });

  it('is empty once the deal has ended, so no timer renders', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    expect(countdown('2026-08-28 11:00:00+00', now)).toBe('');
    expect(countdown(null, now)).toBe('');
  });
});

describe('arrivalWindow', () => {
  it('collapses a one-day window', () => {
    expect(arrivalWindow('2026-09-01', '2026-09-01')).toBe('Arrives Tue 1 Sep');
  });

  it('shows a range otherwise', () => {
    expect(arrivalWindow('2026-09-01', '2026-09-03')).toBe('Arrives Tue 1 Sep – Thu 3 Sep');
  });
});
