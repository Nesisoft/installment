import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text } from './Text';
import { color, font, radius } from '../theme/tokens';

export type ButtonVariant = 'primary' | 'dark' | 'ghost' | 'outline' | 'danger';

export interface ButtonProps {
  label: string;
  /** Second line inside the button — "then 3 × GHS 583 weekly". */
  sublabel?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  full?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SURFACE: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: color.accent, fg: color.onDark },
  dark: { bg: color.ink, fg: color.onDark },
  ghost: { bg: color.surfaceSunk, fg: color.ink },
  outline: { bg: 'transparent', fg: color.ink, border: color.border },
  danger: { bg: color.accentTint, fg: color.accent },
};

export function Button({
  label,
  sublabel,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  icon,
  full = true,
  compact,
  style,
  testID,
}: ButtonProps): React.ReactElement {
  const surface = SURFACE[variant];
  // A button mid-request must not accept a second tap: several of these move
  // money, and the idempotency key is minted per attempt, not per tap.
  const inert = Boolean(disabled || loading);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: Boolean(loading) }}
      accessibilityLabel={sublabel ? `${label}. ${sublabel}` : label}
      onPress={inert ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        full && styles.full,
        {
          backgroundColor: surface.bg,
          borderColor: surface.border ?? 'transparent',
          borderWidth: surface.border ? 1 : 0,
          opacity: inert ? 0.55 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={surface.fg} />
      ) : (
        <View style={styles.content}>
          {icon}
          <View>
            <Text style={[styles.label, { color: surface.fg }]}>{label}</Text>
            {sublabel ? (
              <Text style={[styles.sublabel, { color: surface.fg }]}>{sublabel}</Text>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 54,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  compact: { minHeight: 40, paddingHorizontal: 14, borderRadius: radius.sm },
  full: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { fontFamily: font.semibold, fontSize: 15.5, letterSpacing: -0.2, textAlign: 'center' },
  sublabel: { fontFamily: font.regular, fontSize: 12, opacity: 0.78, textAlign: 'center' },
});
