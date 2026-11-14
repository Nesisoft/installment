/**
 * How the app lays itself out at a given window width, as a pure function.
 *
 * The seller app is also the seller website, and a browser window can be
 * anything from a phone held upright to a desktop monitor at the counter.
 * Below {@link WIDE_MIN} the app is the phone design, unchanged. At or above
 * it the tab bar gives way to a navigation bar along the top, and pages sit in
 * a centred column instead of stretching edge to edge.
 *
 * The same breakpoints as the shopper app's `layout-math.ts`, deliberately
 * kept as this app's own copy, like its tokens: the two apps are allowed to
 * diverge. There are no product grids here, so none of the shop's column
 * arithmetic.
 */

/** Window width at which the desktop layout takes over. */
export const WIDE_MIN = 900;

/** The widest the navigation bar's contents get. */
export const CONTENT_MAX = 1200;

/** The widest a page gets: an order, the day's numbers, a list of payouts. */
export const READING_MAX = 720;

/** The widest a sign-in or sign-up form gets. */
export const FORM_MAX = 480;

export type PageWidth = 'reading' | 'form';

export interface LayoutMetrics {
  width: number;
  /** Whether the desktop layout applies. */
  wide: boolean;
}

export function layoutFor(width: number): LayoutMetrics {
  const safeWidth = Math.max(0, width);
  return { width: safeWidth, wide: safeWidth >= WIDE_MIN };
}

/** How wide a page's column is allowed to grow, or `undefined` on a phone. */
export function pageMaxWidth(wide: boolean, page: PageWidth = 'reading'): number | undefined {
  if (!wide) return undefined;
  return page === 'form' ? FORM_MAX : READING_MAX;
}
