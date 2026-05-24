import { describe, expect, it } from 'vitest';
import { daysBetween, monthsBetween, yearsBetween } from './time';

describe('daysBetween', () => {
  it('counts whole days and clamps negatives to 0', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(daysBetween(from, new Date('2026-01-31T00:00:00Z'))).toBe(30);
    expect(daysBetween(from, new Date('2026-01-01T23:59:59Z'))).toBe(0);
    expect(daysBetween(new Date('2026-02-01T00:00:00Z'), from)).toBe(0);
  });
});

describe('yearsBetween', () => {
  it('only counts completed years', () => {
    const dob = new Date('2000-06-15T00:00:00Z');
    expect(yearsBetween(dob, new Date('2026-06-15T00:00:00Z'))).toBe(26);
    expect(yearsBetween(dob, new Date('2026-06-14T00:00:00Z'))).toBe(25);
    expect(yearsBetween(dob, new Date('2026-12-31T00:00:00Z'))).toBe(26);
  });
});

describe('monthsBetween', () => {
  it('only counts completed months and clamps at 0', () => {
    const start = new Date('2025-01-10T00:00:00Z');
    expect(monthsBetween(start, new Date('2026-01-10T00:00:00Z'))).toBe(12);
    expect(monthsBetween(start, new Date('2025-02-09T00:00:00Z'))).toBe(0);
    expect(monthsBetween(start, new Date('2025-03-10T00:00:00Z'))).toBe(2);
    expect(monthsBetween(new Date('2026-01-10T00:00:00Z'), start)).toBe(0);
  });
});
