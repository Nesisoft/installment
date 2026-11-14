import { describe, expect, it } from 'vitest';
import {
  CONTENT_MAX,
  GRID_GAP,
  PAGE_GUTTER,
  READING_MAX,
  WIDE_MIN,
  gridColumns,
  layoutFor,
} from './layout-math';

describe('layoutFor', () => {
  it('is the phone design on a phone', () => {
    const phone = layoutFor(390);
    expect(phone.wide).toBe(false);
    expect(phone.columns).toBe(2);
    // The grid the design draws: two tiles and one gap inside the gutters.
    expect(phone.gridItemWidth).toBe(Math.floor((390 - PAGE_GUTTER * 2 - GRID_GAP) / 2));
    expect(phone.frameWidth).toBe(390);
  });

  it('switches to the desktop layout at the breakpoint and not before', () => {
    expect(layoutFor(WIDE_MIN - 1).wide).toBe(false);
    expect(layoutFor(WIDE_MIN).wide).toBe(true);
  });

  it('stops pages growing past the content and reading widths', () => {
    const desktop = layoutFor(1920);
    expect(desktop.frameWidth).toBe(CONTENT_MAX);
    expect(desktop.readingWidth).toBe(READING_MAX);
  });

  it('keeps every tile the same size, and the row inside the frame', () => {
    for (const width of [360, 390, 600, 768, 900, 1024, 1280, 1440, 2560]) {
      const { columns, gridItemWidth, frameWidth } = layoutFor(width);
      const row = columns * gridItemWidth + GRID_GAP * (columns - 1);
      expect(row).toBeLessThanOrEqual(frameWidth - PAGE_GUTTER * 2);
      // A tile never shrinks below what the card was drawn for.
      expect(gridItemWidth).toBeGreaterThanOrEqual(150);
    }
  });

  it('adds columns as the window widens', () => {
    expect([390, 700, 1000, 1400].map(gridColumns)).toEqual([2, 3, 4, 5]);
  });

  it('survives a zero-width first frame', () => {
    // React Native Web can report 0 before the first layout.
    const empty = layoutFor(0);
    expect(empty.gridItemWidth).toBeGreaterThanOrEqual(0);
    expect(empty.wide).toBe(false);
  });
});
