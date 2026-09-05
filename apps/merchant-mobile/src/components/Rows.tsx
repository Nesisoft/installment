import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { color, font, radius, space } from '../theme/tokens';

export type Dot = 'primary' | 'warn' | 'info' | 'accent' | 'muted';

const DOT_COLOR: Record<Dot, string> = {
  primary: color.primary,
  warn: color.warn,
  info: color.info,
  accent: color.accent,
  muted: color.mutedSoft,
};

/**
 * A coloured bullet. The design uses one consistently to say which pot a figure
 * belongs to — green is the seller's, amber is held, blue is Ejua's exposure —
 * so the colour is a label, not decoration, and every place a figure appears it
 * carries the same one.
 */
export function StatusDot({
  tone,
  style,
}: {
  tone: Dot;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return <View style={[styles.dot, { backgroundColor: DOT_COLOR[tone] }, style]} />;
}

export interface MoneyRowProps {
  label: string;
  sub?: string;
  value: string;
  tone?: Dot;
  /** Hairline above the row, for a list of them inside one card. */
  divided?: boolean;
}

/** `● Payable now / 2 orders credited today .......... GHS 905.60` */
export function MoneyRow({
  label,
  sub,
  value,
  tone = 'muted',
  divided,
}: MoneyRowProps): React.ReactElement {
  return (
    <View style={[styles.moneyRow, divided && styles.divided]}>
      <StatusDot tone={tone} style={styles.moneyDot} />
      <View style={styles.moneyText}>
        <Text variant="smallMedium">{label}</Text>
        {sub ? (
          <Text variant="tiny" tone="faint" style={styles.sub}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Text style={styles.moneyValue}>{value}</Text>
    </View>
  );
}

export interface ActionRowProps {
  count: number;
  title: string;
  body: string;
  tone?: Dot;
  onPress?: () => void;
}

/**
 * One "needs your action" row: a count, what it is, and what happens if it is
 * ignored.
 *
 * The body is not a restatement of the title. Every row in the design says the
 * consequence — "hidden from customers until you restock", "confirm within 24h"
 * — because a count on its own does not tell a seller whether to act now.
 */
export function ActionRow({
  count,
  title,
  body,
  tone = 'accent',
  onPress,
}: ActionRowProps): React.ReactElement {
  const badge = TINT[tone];
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${count}. ${title}. ${body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && onPress ? styles.pressed : null]}
    >
      <View style={[styles.badge, { backgroundColor: badge.bg }]}>
        <Text style={[styles.badgeText, { color: badge.fg }]}>{count}</Text>
      </View>
      <View style={styles.actionText}>
        <Text variant="smallMedium">{title}</Text>
        <Text variant="tiny" tone="faint" style={styles.sub}>
          {body}
        </Text>
      </View>
      {onPress ? <Icon name="chevron-right" size={16} color={color.mutedSoft} /> : null}
    </Pressable>
  );
}

const TINT: Record<Dot, { bg: string; fg: string }> = {
  primary: { bg: color.primaryTint, fg: color.primary },
  warn: { bg: color.warnTint, fg: color.warnDeep },
  info: { bg: color.infoTint, fg: color.info },
  accent: { bg: color.accentTint, fg: color.accent },
  muted: { bg: color.surfaceSunk, fg: color.muted },
};

export interface StatTileProps {
  eyebrow: string;
  value: string;
  sub?: string;
  tone?: Dot;
  style?: StyleProp<ViewStyle>;
}

/** One of the 2×2 figures on Payouts and Performance. */
export function StatTile({
  eyebrow,
  value,
  sub,
  tone = 'muted',
  style,
}: StatTileProps): React.ReactElement {
  return (
    <View style={[styles.tile, style]}>
      <View style={styles.tileHead}>
        <StatusDot tone={tone} />
        <Text variant="eyebrow" tone="faint">
          {eyebrow.toUpperCase()}
        </Text>
      </View>
      <Text variant="h2" style={styles.tileValue}>
        {value}
      </Text>
      {sub ? (
        <Text variant="tiny" tone="faint">
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** An avatar tile: initials on a tinted square, as the design draws a shop. */
export function Avatar({
  initials: text,
  size = 40,
  background = color.accent,
  foreground = color.onDark,
}: {
  initials: string;
  size?: number;
  background?: string;
  foreground?: string;
}): React.ReactElement {
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 3.2, backgroundColor: background },
      ]}
    >
      <Text style={[styles.avatarText, { color: foreground, fontSize: size * 0.4 }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { width: 7, height: 7, borderRadius: 4 },
  // Nudged onto the first line's baseline; the tile head centres instead.
  moneyDot: { marginTop: 5 },
  sub: { marginTop: 1 },

  moneyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: 9 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  moneyText: { flex: 1 },
  moneyValue: { fontFamily: font.bold, fontSize: 14.5, color: color.ink, letterSpacing: -0.2 },

  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderSoft,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  pressed: { opacity: 0.7 },
  badge: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: font.bold, fontSize: 14 },
  actionText: { flex: 1 },

  tile: {
    flex: 1,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderSoft,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
  },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tileValue: { marginTop: 2 },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: font.bold },
});
