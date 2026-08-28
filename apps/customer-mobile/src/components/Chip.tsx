import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Text } from './Text';
import { color, font, radius } from '../theme/tokens';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

/** The filter/category chips: dark when chosen, sunk surface when not. */
export function Chip({ label, selected, onPress }: ChipProps): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? color.ink : color.surfaceSunk, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Text style={[styles.label, { color: selected ? color.onDark : color.inkSoft }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill },
  label: { fontFamily: font.medium, fontSize: 13, letterSpacing: -0.1 },
});
