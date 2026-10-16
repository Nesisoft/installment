import React from 'react';
import { StyleSheet } from 'react-native';
import { Text } from './Text';
import { Line, Total } from './Settlement';
import { ghs } from '../lib/format';
import { pct, type SaleSplit } from '../lib/fees';
import { space } from '../theme/tokens';

export interface SaleSplitsProps {
  /** From `saleSplits`: paid in full first, then one per plan type. */
  splits: SaleSplit[];
  dark?: boolean;
}

/**
 * One sale, as each way it can be paid leaves the seller.
 *
 * Paid in full gets the whole breakdown. Each plan type gets one row with its
 * rates in the qualifier column, because which plan applies is the buyer's
 * choice at checkout — a single "Ejua fee" line would be right for some sales
 * and wrong for the rest.
 */
export function SaleSplits({ splits, dark }: SaleSplitsProps): React.ReactElement | null {
  const [payNow, ...plans] = splits;
  if (!payNow) return null;
  return (
    <>
      <Line
        label="Ejua fee"
        qualifier={pct(payNow.feeBps)}
        value={`−${ghs(payNow.fee)}`}
        deduction
        dark={dark}
      />
      <Total
        label="Paid to you"
        sub={plans.length ? 'When the buyer pays in full' : undefined}
        value={ghs(payNow.net)}
        dark={dark}
      />
      {plans.length ? (
        <>
          <Text variant="eyebrow" tone={dark ? 'onDarkFaint' : 'faint'} style={styles.head}>
            ON A PLAN · THE BUYER PICKS WHICH
          </Text>
          {plans.map((s) => (
            <Line
              key={s.key}
              label={s.label}
              qualifier={`${pct(s.feeBps)} fee, ${pct(s.reserveBps)} held`}
              value={ghs(s.net)}
              dark={dark}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: space.md },
});
