import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color } from '../theme/tokens';

export interface SparklineBar {
  /** `YYYY-MM-DD`, used only as a key and for the accessibility label. */
  date: string;
  value: number;
}

export interface SparklineProps {
  bars: SparklineBar[];
  /** Total height of the plot, excluding nothing — the bars fill it exactly. */
  height?: number;
  /** Paints the last bar in the accent colour, as the design does for today. */
  highlightLast?: boolean;
  dark?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The daily-sales bars in the today hero.
 *
 * Two things this deliberately does not do. It does not scale to a rolling
 * average or a target — the tallest bar in the window is the top, so the shape
 * is honest about *this* window and nothing else. And a day that sold nothing
 * still draws {@link MIN_BAR} pixels rather than disappearing: a gap in the row
 * reads as "no data", and "we were open and sold nothing" is a different and
 * more useful fact.
 *
 * Heights are pixels computed here, not percentages. A percentage height inside
 * a flex parent whose own height is content-derived resolves against zero, and
 * every bar collapses — which is exactly the bug that shipped on the merchant
 * web chart before it was caught.
 */
const MIN_BAR = 3;

export function Sparkline({
  bars,
  height = 74,
  highlightLast = true,
  dark = true,
  accessibilityLabel,
  style,
}: SparklineProps): React.ReactElement | null {
  if (bars.length === 0) return null;
  const peak = Math.max(...bars.map((b) => b.value), 0);
  const idle = dark ? color.darkLine : color.surfaceSunk;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? 'Sales by day'}
      style={[styles.row, { height }, style]}
    >
      {bars.map((bar, i) => {
        const last = i === bars.length - 1;
        const scaled = peak === 0 ? 0 : Math.round((bar.value / peak) * (height - MIN_BAR));
        return (
          <View
            key={bar.date}
            style={[
              styles.bar,
              {
                height: MIN_BAR + scaled,
                backgroundColor: highlightLast && last ? color.primary : idle,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  // 3, not `radius.xs`: a short bar with a 6px radius is a lozenge, and the
  // shortest bars in a window are the ones whose height has to stay readable.
  bar: { flex: 1, borderRadius: 3, minWidth: 4 },
});
