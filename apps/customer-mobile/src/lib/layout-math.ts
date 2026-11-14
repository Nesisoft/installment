/**
 * How the app lays itself out at a given window width, as a pure function.
 *
 * The same app ships to phones and to the web, and a browser window can be
 * anything from a phone held upright to a 27-inch monitor. Below
 * {@link WIDE_MIN} the app is the phone design, unchanged. At or above it the
 * bottom tab bar gives way to a top navigation bar, pages sit in a centred
 * column instead of stretching edge to edge, and product grids gain columns.
 *
 * Split from `layout.ts` for the same reason `api-url.ts` is split from
 * `config.ts`: the arithmetic is the part worth testing, and a test in node
 * cannot load `react-native`.
 */

/** Window width at which the desktop layout takes over. A tablet in landscape crosses it. */
export const WIDE_MIN = 900;

/** The widest a page's content gets: product grids, the home feed, a shop. */
export const CONTENT_MAX = 1200;

/**
 * The widest a reading page gets: a form, an order, a list of instalments.
 * Lines of text and full-width buttons stop being comfortable well before the
 * window does.
 */
export const READING_MAX = 720;

/** Horizontal padding inside a page, either side. Matches the design's `space.lg`. */
export const PAGE_GUTTER = 16;

/** Gap between grid tiles. Matches the design's `space.md`. */
export const GRID_GAP = 12;

export interface LayoutMetrics {
  /** The window's width. */
  width: number;
  /** Whether the desktop layout applies. */
  wide: boolean;
  /** Width of a full page's content column, before its gutters. */
  frameWidth: number;
  /** Width of a reading page's content column, before its gutters. */
  readingWidth: number;
  /** Product grid columns. */
  columns: number;
  /** Width of one grid tile, so every tile is the same size whatever the count. */
  gridItemWidth: number;
}

/**
 * Columns by width: the design's two on a phone, three on a small tablet, then
 * four and five on a desktop. A tile never falls much below the phone's own
 * ~170 px, which is what the card's type and image were drawn for.
 */
export function gridColumns(width: number): number {
  if (width >= 1180) return 5;
  if (width >= WIDE_MIN) return 4;
  if (width >= 600) return 3;
  return 2;
}

export function layoutFor(width: number): LayoutMetrics {
  const safeWidth = Math.max(0, width);
  const frameWidth = Math.min(safeWidth, CONTENT_MAX);
  const columns = gridColumns(safeWidth);
  const inner = Math.max(0, frameWidth - PAGE_GUTTER * 2);
  return {
    width: safeWidth,
    wide: safeWidth >= WIDE_MIN,
    frameWidth,
    readingWidth: Math.min(safeWidth, READING_MAX),
    columns,
    gridItemWidth: Math.max(0, Math.floor((inner - GRID_GAP * (columns - 1)) / columns)),
  };
}
