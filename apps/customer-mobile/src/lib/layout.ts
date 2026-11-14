import { useWindowDimensions } from 'react-native';
import { layoutFor, type LayoutMetrics } from './layout-math';

export * from './layout-math';

/**
 * The layout for the current window, recomputed when it is resized or a phone
 * is turned. Every width-dependent decision reads this rather than measuring
 * the window itself, so the breakpoints live in one place.
 */
export function useLayout(): LayoutMetrics {
  const { width } = useWindowDimensions();
  return layoutFor(width);
}
