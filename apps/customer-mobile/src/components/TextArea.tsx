import React from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Text } from './Text';
import { color, font, radius, space } from '../theme/tokens';

export interface TextAreaProps extends Omit<TextInputProps, 'style' | 'multiline'> {
  label?: string;
  /** Drawn under the box, and turned accent when the count is over. */
  hint?: string;
  /** Shows "n / max" once the buyer is close, and blocks going past it. */
  maxLength?: number;
  minHeight?: number;
}

/**
 * The app's first multiline input.
 *
 * There was no multiline `TextInput` anywhere in this app before — every field
 * is a single line, and the only labelled-input pattern is a private `Field`
 * helper inside `checkout.tsx`. Two things had to be got right that a
 * single-line field never surfaces:
 *
 *   - `textAlignVertical: 'top'` on Android. Without it the caret sits in the
 *     vertical middle of the box and the first line of a long reason floats,
 *     which reads as a broken control rather than a tall one.
 *   - a `minHeight` rather than a fixed `height`, so the box grows with the
 *     text instead of scrolling inside itself on a small handset.
 *
 * The counter only appears in the last quarter of the allowance: a character
 * count over an empty box is a warning about a limit nobody was going to reach.
 */
export function TextArea({
  label,
  hint,
  maxLength,
  minHeight = 104,
  value,
  ...rest
}: TextAreaProps): React.ReactElement {
  const length = value?.length ?? 0;
  const nearLimit = maxLength !== undefined && length > maxLength * 0.75;

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text variant="eyebrow" tone="faint">
          {label.toUpperCase()}
        </Text>
      ) : null}
      <TextInput
        multiline
        value={value}
        maxLength={maxLength}
        placeholderTextColor={color.mutedSoft}
        style={[styles.input, { minHeight }]}
        {...rest}
      />
      {hint || nearLimit ? (
        <View style={styles.footer}>
          {hint ? (
            <Text variant="tiny" tone="faint" style={styles.hint}>
              {hint}
            </Text>
          ) : null}
          {nearLimit ? (
            <Text variant="tiny" tone={length === maxLength ? 'accent' : 'faint'}>
              {`${length} / ${maxLength}`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  input: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderSoft,
    borderRadius: radius.md,
    padding: space.lg,
    // Hardcoded rather than from `type.body`, the same way checkout's `Field`
    // does it: a TextInput does not inherit a font family from a parent style.
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: color.ink,
    // Android centres a multiline caret vertically without this.
    ...Platform.select({ android: { textAlignVertical: 'top' as const } }),
  },
  footer: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  hint: { flex: 1, lineHeight: 16 },
});
