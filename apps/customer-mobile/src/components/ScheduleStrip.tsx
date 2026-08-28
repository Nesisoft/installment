import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { color, radius, space } from '../theme/tokens';
import { ghs } from '../lib/format';
import { shortDate } from '../lib/dates';
import type { QuotedInstallment } from '../features/types';

export interface ScheduleStripProps {
  installments: QuotedInstallment[];
  /** Dark ground (the product panel sits on white; the sheet on ink). */
  dark?: boolean;
}

/**
 * The pay-in-N schedule, as the row of cards the design shows.
 *
 * The first card is the deposit — due today, on MoMo — and the rest are the
 * financed instalments with their real dates. The count of cards is the number
 * the customer should think in ("pay in 4"), which is why nothing here uses
 * `number_of_installments`: that field excludes the deposit, and using it would
 * tell someone they owe one payment fewer than they do.
 */
export function ScheduleStrip({ installments, dark }: ScheduleStripProps): React.ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {installments.map((row, index) => {
        const isDeposit = row.kind === 'down_payment';
        const label = isDeposit
          ? 'TODAY'
          : `PAYMENT ${index + (installments[0]?.kind === 'down_payment' ? 0 : 1)}`;
        return (
          <View
            key={row.sequence_number}
            style={[
              styles.cell,
              isDeposit ? styles.deposit : dark ? styles.onDark : styles.instalment,
            ]}
          >
            <Text
              variant="eyebrow"
              tone={isDeposit ? 'onDarkMuted' : dark ? 'onDarkFaint' : 'faint'}
            >
              {label}
            </Text>
            <Text
              variant="h3"
              tone={isDeposit ? 'onDark' : dark ? 'onDark' : 'ink'}
              style={styles.amount}
            >
              {ghs(row.amount_pesewas)}
            </Text>
            <Text variant="tiny" tone={isDeposit ? 'onDarkMuted' : dark ? 'onDarkFaint' : 'muted'}>
              {isDeposit ? 'MoMo' : shortDate(row.due_date)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: space.sm, paddingRight: space.lg },
  cell: {
    minWidth: 92,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    gap: 3,
  },
  deposit: { backgroundColor: color.ink },
  instalment: { backgroundColor: color.surfaceSunk },
  onDark: { backgroundColor: color.darkHover },
  amount: { marginTop: 1 },
});
