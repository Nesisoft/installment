import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { color, font, radius } from '../theme/tokens';

export type PillTone = 'neutral' | 'primary' | 'accent' | 'warn' | 'info' | 'dark' | 'onDark';

const TONES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: color.surfaceSunk, fg: color.muted },
  primary: { bg: color.primaryTint, fg: color.primary },
  accent: { bg: color.accentTint, fg: color.accent },
  warn: { bg: color.warnTint, fg: color.warnDeep },
  info: { bg: color.infoTint, fg: color.info },
  dark: { bg: color.ink, fg: color.onDark },
  onDark: { bg: 'rgba(255,253,249,0.12)', fg: color.onDark },
};

export interface PillProps {
  label: string;
  tone?: PillTone;
  style?: StyleProp<ViewStyle>;
}

/** The status chips the design uses everywhere: NEW, VERIFIED, AUTOMATIC. */
export function Pill({ label, tone = 'neutral', style }: PillProps): React.ReactElement {
  const t = TONES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.label, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.xs,
    alignSelf: 'flex-start',
  },
  label: { fontFamily: font.bold, fontSize: 9.5, letterSpacing: 0.9 },
});
