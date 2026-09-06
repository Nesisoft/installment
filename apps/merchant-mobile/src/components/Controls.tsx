import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { color, font, radius, space } from '../theme/tokens';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Rendered beside the label. `undefined` shows no count, which is not zero. */
  count?: number;
}

export interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Scrolls horizontally — the order queue has six filters and they do not fit. */
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The filter chips at the top of the queue, catalogue and plan lists.
 *
 * A count of `undefined` renders no number at all, and that distinction is
 * load-bearing: while a count is still loading, showing nothing is honest and
 * showing `0` says the filter is empty.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  scroll = true,
  style,
}: SegmentedProps<T>): React.ReactElement {
  const chips = options.map((opt) => {
    const on = opt.value === value;
    return (
      <Pressable
        key={opt.value}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={opt.count === undefined ? opt.label : `${opt.label}, ${opt.count}`}
        onPress={() => onChange(opt.value)}
        style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
      >
        <Text style={[styles.chipText, { color: on ? color.onDark : color.inkSoft }]}>
          {opt.label}
        </Text>
        {opt.count === undefined ? null : (
          <Text style={[styles.chipCount, { color: on ? color.onDarkMuted : color.mutedSoft }]}>
            {opt.count}
          </Text>
        )}
      </Pressable>
    );
  });

  if (!scroll) return <View style={[styles.chipRow, style]}>{chips}</View>;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.chipRow, style]}
    >
      {chips}
    </ScrollView>
  );
}

export interface FieldProps extends TextInputProps {
  label: string;
  /** Sits under the input, in muted type. */
  hint?: string;
  /** Replaces the hint and turns the label red. */
  error?: string | null;
  dark?: boolean;
}

/** A labelled text input, as the canvas draws every form field. */
export function Field({
  label,
  hint,
  error,
  dark,
  style,
  ...rest
}: FieldProps): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text variant="eyebrow" tone={error ? 'accent' : dark ? 'onDarkFaint' : 'faint'}>
        {label}
      </Text>
      <TextInput
        {...rest}
        style={[dark ? styles.inputDark : styles.input, style]}
        placeholderTextColor={dark ? color.onDarkFaint : color.mutedSoft}
        selectionColor={color.primary}
      />
      {error ? (
        <Text variant="tiny" tone="accent">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="tiny" tone="faint">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label: string;
  /** Shown under the row — "Will not show to customers" at zero. */
  note?: string;
  disabled?: boolean;
}

/**
 * The stock stepper on "List a product".
 *
 * Clamped at both ends rather than letting the field go negative and the server
 * refuse it: `inventory.quantity_available` has a `>= 0` CHECK, so a negative
 * here could only ever become a 400 the seller cannot act on.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 100_000,
  label,
  note,
  disabled,
}: StepperProps): React.ReactElement {
  const step = (by: number) => {
    if (disabled) return;
    onChange(Math.min(max, Math.max(min, value + by)));
  };
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepText}>
        <Text variant="smallMedium">{label}</Text>
        {note ? (
          <Text variant="tiny" tone="faint">
            {note}
          </Text>
        ) : null}
      </View>
      <View style={styles.stepControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`One fewer ${label}`}
          disabled={disabled || value <= min}
          onPress={() => step(-1)}
          style={[styles.stepButton, (disabled || value <= min) && styles.stepButtonOff]}
          hitSlop={6}
        >
          <Icon name="minus" size={16} color={color.ink} />
        </Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`One more ${label}`}
          disabled={disabled || value >= max}
          onPress={() => step(1)}
          style={[styles.stepButton, (disabled || value >= max) && styles.stepButtonOff]}
          hitSlop={6}
        >
          <Icon name="plus" size={16} color={color.ink} />
        </Pressable>
      </View>
    </View>
  );
}

export interface ToggleRowProps {
  label: string;
  body?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

/** A switch with an explanation, as the canvas draws "Allow instalments". */
export function ToggleRow({
  label,
  body,
  value,
  onChange,
  disabled,
}: ToggleRowProps): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      accessibilityLabel={body ? `${label}. ${body}` : label}
      onPress={() => !disabled && onChange(!value)}
      style={[styles.toggleRow, disabled && styles.toggleOff]}
    >
      <View style={styles.toggleText}>
        <Text variant="smallMedium">{label}</Text>
        {body ? (
          <Text variant="tiny" tone="faint">
            {body}
          </Text>
        ) : null}
      </View>
      <View style={[styles.track, value ? styles.trackOn : styles.trackOff]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', gap: space.sm, paddingRight: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipOff: { backgroundColor: color.surface, borderColor: color.border },
  chipText: { fontFamily: font.medium, fontSize: 13 },
  chipCount: { fontFamily: font.bold, fontSize: 11.5 },

  field: { gap: 6 },
  input: {
    fontFamily: font.medium,
    fontSize: 16,
    color: color.ink,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  inputDark: {
    fontFamily: font.medium,
    fontSize: 16,
    color: color.onDark,
    backgroundColor: color.darkRaised,
    borderWidth: 1,
    borderColor: color.darkBorder,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },

  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  stepText: { flex: 1 },
  stepControls: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepButton: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
  },
  stepButtonOff: { opacity: 0.35 },
  stepValue: {
    fontFamily: font.bold,
    fontSize: 15,
    color: color.ink,
    minWidth: 26,
    textAlign: 'center',
  },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  toggleOff: { opacity: 0.5 },
  toggleText: { flex: 1 },
  track: { width: 46, height: 27, borderRadius: radius.pill, padding: 3, justifyContent: 'center' },
  trackOn: { backgroundColor: color.primary },
  trackOff: { backgroundColor: color.borderStrong },
  knob: { width: 21, height: 21, borderRadius: radius.pill, backgroundColor: color.surface },
  knobOn: { alignSelf: 'flex-end' },
});
