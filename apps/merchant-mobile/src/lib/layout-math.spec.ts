import { describe, expect, it } from 'vitest';
import { FORM_MAX, READING_MAX, WIDE_MIN, layoutFor, pageMaxWidth } from './layout-math';

describe('layoutFor', () => {
  it('is the phone design below the breakpoint and the desktop layout from it', () => {
    expect(layoutFor(390).wide).toBe(false);
    expect(layoutFor(WIDE_MIN - 1).wide).toBe(false);
    expect(layoutFor(WIDE_MIN).wide).toBe(true);
  });

  it('survives a zero or negative first frame', () => {
    expect(layoutFor(0)).toEqual({ width: 0, wide: false });
    expect(layoutFor(-5)).toEqual({ width: 0, wide: false });
  });
});

describe('pageMaxWidth', () => {
  it('leaves a phone alone', () => {
    expect(pageMaxWidth(false)).toBeUndefined();
    expect(pageMaxWidth(false, 'form')).toBeUndefined();
  });

  it('caps pages at the reading width and sign-in forms narrower', () => {
    expect(pageMaxWidth(true)).toBe(READING_MAX);
    expect(pageMaxWidth(true, 'form')).toBe(FORM_MAX);
    expect(FORM_MAX).toBeLessThan(READING_MAX);
  });
});
