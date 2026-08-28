import { describe, expect, it } from 'vitest';
import {
  cadence,
  cedis,
  compact,
  ghs,
  ghsExact,
  initials,
  phoneDisplay,
  phoneE164,
} from './format';

describe('money formatting', () => {
  it('renders whole cedis with thousands separators', () => {
    expect(ghs(28_990_000)).toBe('GHS 289,900');
    expect(ghs(0)).toBe('GHS 0');
  });

  it('renders an em dash rather than "GHS NaN" for a missing amount', () => {
    expect(ghs(null)).toBe('—');
    expect(ghs(undefined)).toBe('—');
  });

  it('keeps the pesewas where they matter', () => {
    expect(ghsExact(28_990_050)).toBe('GHS 289,900.50');
    expect(ghsExact(1)).toBe('GHS 0.01');
  });

  it('gives a bare number when a GHS label is already on screen', () => {
    expect(cedis(58_280)).toBe('583');
  });
});

describe('compact', () => {
  it('abbreviates the way the design does', () => {
    expect(compact(640)).toBe('640');
    expect(compact(1_200)).toBe('1.2k');
    expect(compact(6_400)).toBe('6.4k');
    expect(compact(64_000)).toBe('64k');
    expect(compact(1_500_000)).toBe('1.5m');
  });
});

describe('cadence', () => {
  it('names the intervals the engine actually schedules', () => {
    expect(cadence(7)).toBe('weekly');
    expect(cadence(14)).toBe('fortnightly');
    expect(cadence(30)).toBe('monthly');
    expect(cadence(10)).toBe('every 10 days');
  });
});

describe('phone', () => {
  it('formats a stored E.164 number for display', () => {
    expect(phoneDisplay('+233240000002')).toBe('+233 24 000 0002');
  });

  it('leaves an unexpected number alone rather than mangling it', () => {
    expect(phoneDisplay('12345')).toBe('12345');
    expect(phoneDisplay(null)).toBe('—');
  });

  it('normalises every shape a customer might type', () => {
    expect(phoneE164('0240000002')).toBe('+233240000002');
    expect(phoneE164('240000002')).toBe('+233240000002');
    expect(phoneE164('+233 24 000 0002')).toBe('+233240000002');
    expect(phoneE164('233240000002')).toBe('+233240000002');
  });
});

describe('initials', () => {
  it('takes the first and last name', () => {
    expect(initials('Ama Boateng')).toBe('AB');
    expect(initials('Kwame Nkrumah Osei')).toBe('KO');
  });

  it('copes with one name, or none', () => {
    expect(initials('Ama')).toBe('AM');
    expect(initials('   ')).toBe('?');
  });
});
