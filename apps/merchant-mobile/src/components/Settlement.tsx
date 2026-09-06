import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { color, font, radius, space } from '../theme/tokens';

export interface LineProps {
  label: string;
  /** A rate or qualifier printed beside the label — "4%", "5%", "×2". */
  qualifier?: string;
  value: string;
  /** Renders the value in red with a leading minus already in the string. */
  deduction?: boolean;
  strong?: boolean;
}

/**
 * One row of a money breakdown.
 *
 * The qualifier sits with the label rather than being folded into it because
 * the canvas aligns the rates in their own column — a seller checking their MDR
 * scans that column, and "Ejua MDR 4%" as one string breaks the scan.
 */
export function Line({
  label,
  qualifier,
  value,
  deduction,
  strong,
}: LineProps): React.ReactElement {
  return (
    <View style={styles.line}>
      <Text variant={strong ? 'smallMedium' : 'small'} tone={strong ? 'ink' : 'soft'}>
        {label}
      </Text>
      {qualifier ? (
        <Text variant="tiny" tone="faint" style={styles.qualifier}>
          {qualifier}
        </Text>
      ) : null}
      <View style={styles.spacer} />
      <Text
        style={[styles.value, strong && styles.valueStrong, deduction && { color: color.accent }]}
      >
        {value}
      </Text>
    </View>
  );
}

export interface TotalProps {
  label: string;
  sub?: string;
  value: string;
  style?: StyleProp<ViewStyle>;
}

/** The bold "Paid to you at approval" row that closes a breakdown. */
export function Total({ label, sub, value, style }: TotalProps): React.ReactElement {
  return (
    <View style={[styles.total, style]}>
      <View style={styles.totalText}>
        <Text variant="smallMedium">{label}</Text>
        {sub ? (
          <Text variant="tiny" tone="faint">
            {sub}
          </Text>
        ) : null}
      </View>
      <Text style={styles.totalValue}>{value}</Text>
    </View>
  );
}

export interface TimelineStep {
  title: string;
  /** When it happened, or what it is waiting on. */
  body: string;
  state: 'done' | 'current' | 'future';
}

/**
 * The order timeline.
 *
 * Three states, not two: the canvas distinguishes what has happened, what is
 * waiting on the seller right now, and what has not happened yet. A two-state
 * timeline would draw "Waiting on you" the same as "Delivered — pending", and
 * the whole point of the screen is that the seller can see which one is theirs.
 */
export function Timeline({ steps }: { steps: TimelineStep[] }): React.ReactElement {
  return (
    <View>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <View key={`${step.title}-${i}`} style={styles.step}>
            <View style={styles.rail}>
              <View
                style={[
                  styles.node,
                  step.state === 'done' && styles.nodeDone,
                  step.state === 'current' && styles.nodeCurrent,
                ]}
              />
              {last ? null : (
                <View style={[styles.spine, step.state === 'done' && styles.spineDone]} />
              )}
            </View>
            <View style={styles.stepText}>
              <Text
                variant="smallMedium"
                tone={step.state === 'future' ? 'faint' : 'ink'}
                style={styles.stepTitle}
              >
                {step.title}
              </Text>
              <Text variant="tiny" tone={step.state === 'current' ? 'accent' : 'faint'}>
                {step.body}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

export interface ScheduleCell {
  /** "DOWN", "WK 1" — the canvas's own short labels. */
  label: string;
  amount: string;
  /** "collected", "upcoming", "overdue". */
  state: string;
  tone: 'done' | 'due' | 'late' | 'future';
}

/** The DOWN / WK 1 / WK 2 / WK 3 strip on an order and on a plan. */
export function ScheduleStrip({
  cells,
  dark,
}: {
  cells: ScheduleCell[];
  dark?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.strip}>
      {cells.map((cell, i) => (
        <View
          key={`${cell.label}-${i}`}
          style={[
            styles.cell,
            dark ? styles.cellDark : styles.cellLight,
            cell.tone === 'done' && styles.cellDone,
            cell.tone === 'late' && styles.cellLate,
          ]}
        >
          <Text variant="eyebrow" tone={dark ? 'onDarkFaint' : 'faint'}>
            {cell.label}
          </Text>
          <Text style={[styles.cellAmount, dark && { color: color.onDark }]}>{cell.amount}</Text>
          <Text variant="tiny" tone={dark ? 'onDarkFaint' : 'faint'}>
            {cell.state}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A block of explanation the canvas prints in several places — who carries the
 * risk, what the reserve is, why a payout rolled over.
 */
export function Note({
  eyebrow,
  children,
  tone = 'neutral',
}: {
  eyebrow?: string;
  children: string;
  tone?: 'neutral' | 'primary' | 'warn';
}): React.ReactElement {
  const bg =
    tone === 'primary' ? color.primaryTint : tone === 'warn' ? color.warnTint : color.surfaceSunk;
  return (
    <View style={[styles.note, { backgroundColor: bg }]}>
      {eyebrow ? (
        <Text variant="eyebrow" tone="faint">
          {eyebrow.toUpperCase()}
        </Text>
      ) : null}
      <Text variant="tiny" tone="soft" style={styles.noteBody}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, paddingVertical: 5 },
  qualifier: {},
  spacer: { flex: 1 },
  value: { fontFamily: font.medium, fontSize: 13.5, color: color.inkSoft },
  valueStrong: { fontFamily: font.bold, fontSize: 15, color: color.ink },

  total: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingTop: space.md,
    marginTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  totalText: { flex: 1 },
  totalValue: { fontFamily: font.extrabold, fontSize: 19, color: color.ink, letterSpacing: -0.5 },

  step: { flexDirection: 'row', gap: space.md },
  rail: { alignItems: 'center', width: 14 },
  node: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginTop: 5,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  nodeDone: { backgroundColor: color.primary, borderColor: color.primary },
  nodeCurrent: { backgroundColor: color.accent, borderColor: color.accent },
  spine: { flex: 1, width: 1.5, backgroundColor: color.borderSoft, marginVertical: 3 },
  spineDone: { backgroundColor: color.primaryLine },
  stepText: { flex: 1, paddingBottom: space.lg },
  stepTitle: { marginBottom: 1 },

  strip: { flexDirection: 'row', gap: 6 },
  cell: { flex: 1, borderRadius: radius.sm, padding: space.sm, gap: 1, borderWidth: 1 },
  cellLight: { backgroundColor: color.surfaceSunk, borderColor: 'transparent' },
  cellDark: { backgroundColor: color.darkHover, borderColor: color.darkBorder },
  cellDone: { backgroundColor: color.primaryTint, borderColor: color.primaryLine },
  cellLate: { backgroundColor: color.accentTint, borderColor: color.accentTint },
  cellAmount: { fontFamily: font.bold, fontSize: 14, color: color.ink, letterSpacing: -0.2 },

  note: { borderRadius: radius.md, padding: space.md, gap: 4 },
  noteBody: { lineHeight: 17 },
});
