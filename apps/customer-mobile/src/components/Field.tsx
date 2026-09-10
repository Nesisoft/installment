import React from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Text } from './Text';
import { color, font, radius, space } from '../theme/tokens';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Drawn under the box in muted text; turns accent when `error` is set. */
  hint?: string;
  error?: string | null;
  /** Adds a muted "optional" to the label, so a blank field reads as allowed. */
  optional?: boolean;
}

/**
 * A labelled single-line input.
 *
 * Lifted out of `checkout.tsx`, where it lived as a private helper. The address
 * form needs the same control and a second hand-rolled copy is how two inputs
 * in one app end up a pixel and a font apart.
 *
 * `fontFamily` is hardcoded rather than taken from `type.body`, the same way
 * the original did it: a `TextInput` does not inherit a font family from a
 * parent style, so leaving it out silently drops Outfit for the system face.
 */
export function Field({ label, hint, error, optional, ...rest }: FieldProps): React.ReactElement {
  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <Text variant="eyebrow" tone="faint">
          {label.toUpperCase()}
        </Text>
        {optional ? (
          <Text variant="eyebrow" tone="faint">
            OPTIONAL
          </Text>
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.mutedSoft}
        style={[styles.input, error ? styles.inputError : null]}
        {...rest}
      />
      {error || hint ? (
        <Text variant="tiny" tone={error ? 'accent' : 'faint'} style={styles.hint}>
          {error ?? hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
    height: 48,
    paddingHorizontal: space.md,
    fontFamily: font.regular,
    fontSize: 15,
    color: color.ink,
  },
  inputError: { borderColor: color.accent },
  hint: { lineHeight: 16 },
});
