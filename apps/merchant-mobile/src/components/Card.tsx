import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '../theme/tokens';

export interface CardProps {
  children: React.ReactNode;
  dark?: boolean;
  /** No padding — for a card whose child manages its own edges. */
  bare?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, dark, bare, style }: CardProps): React.ReactElement {
  return (
    <View style={[styles.card, dark ? styles.dark : styles.light, !bare && styles.padded, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, overflow: 'hidden' },
  padded: { padding: space.lg },
  light: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.borderSoft },
  dark: { backgroundColor: color.ink },
});
