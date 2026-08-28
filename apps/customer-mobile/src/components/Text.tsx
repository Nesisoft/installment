import React from 'react';
import { StyleSheet, Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { color, type } from '../theme/tokens';

type Variant = keyof typeof type;

export interface TextProps extends RNTextProps {
  variant?: Variant;
  tone?: keyof typeof TONE;
  center?: boolean;
}

const TONE = {
  ink: color.ink,
  soft: color.inkSoft,
  muted: color.muted,
  faint: color.mutedSoft,
  accent: color.accent,
  success: color.success,
  warn: color.warn,
  onDark: color.onDark,
  onDarkMuted: color.onDarkMuted,
  onDarkFaint: color.onDarkFaint,
} as const;

/**
 * The only way text is rendered.
 *
 * Wrapping `Text` is what keeps Outfit on every string: React Native does not
 * inherit fonts across component boundaries, so a bare `<RNText>` silently
 * falls back to Roboto and the screen stops looking like the design.
 */
export function Text({
  variant = 'body',
  tone = 'ink',
  center,
  style,
  ...rest
}: TextProps): React.ReactElement {
  return (
    <RNText
      {...rest}
      style={[type[variant], { color: TONE[tone] }, center && styles.center, style]}
    />
  );
}

const styles = StyleSheet.create({ center: { textAlign: 'center' } });
