import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantReturnBucket, MerchantReturnRow } from '@installment/api-types';
import {
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  Loading,
  Note,
  Pill,
  Screen,
  Segmented,
  Text,
  type PillTone,
  type SegmentOption,
} from '../../src/components';
import { useReturnCounts, useReturns } from '../../src/features/merchant';
import { shortDate } from '../../src/lib/dates';
import { ghs } from '../../src/lib/format';
import { color, font, space } from '../../src/theme/tokens';

const CHIPS: { value: MerchantReturnBucket; label: string }[] = [
  { value: 'requested', label: 'Waiting on you' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Refused' },
  { value: 'all', label: 'All' },
];

const EMPTY: Record<MerchantReturnBucket, { title: string; body: string }> = {
  requested: {
    title: 'Nothing waiting on you',
    body: 'When a buyer asks to send something back, it appears here for you to accept or refuse.',
  },
  approved: {
    title: 'You have not accepted any returns',
    body: 'An accepted return is refunded to the buyer and put back on your shelf.',
  },
  rejected: {
    title: 'You have not refused any returns',
    body: 'A refusal has to say why, and the buyer is shown what you wrote.',
  },
  cancelled: {
    title: 'Nothing withdrawn',
    body: 'A buyer can withdraw a request before you decide on it.',
  },
  all: {
    title: 'Nobody has sent anything back',
    body: 'Every sale has stayed sold. Returns you are asked for will appear here.',
  },
};

export const RETURN_PILL: Record<string, { label: string; tone: PillTone }> = {
  requested: { label: 'WAITING ON YOU', tone: 'warn' },
  approved: { label: 'APPROVED', tone: 'primary' },
  rejected: { label: 'REFUSED', tone: 'neutral' },
  cancelled: { label: 'WITHDRAWN', tone: 'neutral' },
};

/**
 * What buyers are sending back.
 *
 * The engine has served this since the returns slice and nothing reached it, so
 * a seller could not accept or refuse anything from their phone — the one
 * obligation in this app with money attached that had no screen.
 */
export default function ReturnsScreen(): React.ReactElement {
  const [bucket, setBucket] = useState<MerchantReturnBucket>('requested');
  const returns = useReturns(bucket);
  const counts = useReturnCounts();

  const refresh = useCallback(() => {
    void returns.refetch();
    void counts.refetch();
  }, [returns, counts]);

  const options: SegmentOption<MerchantReturnBucket>[] = CHIPS.map((chip) => ({
    ...chip,
    count: counts.data?.[chip.value],
  }));

  const header = (
    <View style={styles.top}>
      <Header back flush title="Returns" />
      <Segmented options={options} value={bucket} onChange={setBucket} style={styles.chips} />
    </View>
  );

  if (returns.isPending) {
    return (
      <Screen>
        {header}
        <Loading />
      </Screen>
    );
  }

  if (returns.error) {
    return (
      <Screen>
        {header}
        <ErrorState
          message={apiErrorMessage(returns.error, 'Could not load your returns.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const rows = returns.data?.rows ?? [];
  const empty = EMPTY[bucket];
  const waiting = counts.data?.requested ?? 0;

  return (
    <Screen refreshing={returns.isFetching} onRefresh={refresh}>
      {header}
      <View style={styles.body}>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Icon name="box" size={30} color={color.mutedSoft} />}
            title={empty.title}
            body={empty.body}
          />
        ) : (
          rows.map((row) => <ReturnCard key={row.id} row={row} />)
        )}

        {waiting > 0 ? (
          <Note eyebrow="Nothing moves until you decide">
            {/* True and load-bearing: `request` writes a row and touches
                nothing else. The order stays `paid` and the seller stays
                credited until approve or reject runs. */}
            A request on its own changes nothing — the sale stands and you keep what you were paid.
            Accepting is what refunds the buyer, takes the money back off your balance and puts the
            goods on your shelf again.
          </Note>
        ) : null}
      </View>
    </Screen>
  );
}

function ReturnCard({ row }: { row: MerchantReturnRow }): React.ReactElement {
  const pill = RETURN_PILL[row.status] ?? {
    label: row.status.toUpperCase(),
    tone: 'neutral' as const,
  };
  const open = row.status === 'requested';
  const spoken = [
    row.orderNumber,
    row.itemSummary ?? '',
    row.buyerName ? `from ${row.buyerName}` : '',
    `${ghs(row.refundPesewas)} to refund`,
    pill.label.toLowerCase(),
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={() => router.push(`/returns/${row.id}`)}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <Card style={styles.card}>
        <View style={styles.head}>
          <Text variant="eyebrowLg" tone="faint" numberOfLines={1} style={styles.reference}>
            {row.orderNumber}
          </Text>
          <Pill label={pill.label} tone={pill.tone} />
        </View>

        <View>
          <Text variant="smallMedium" numberOfLines={1}>
            {row.itemSummary ?? 'Item no longer on file'}
          </Text>
          <Text variant="tiny" tone="faint" numberOfLines={1}>
            {[row.buyerName ?? 'Buyer', shortDate(row.requestedAt)].join(' · ')}
          </Text>
        </View>

        {/* The buyer's own words, and the thing the decision actually turns on
            — "wrong size" and "arrived cracked" are different decisions. */}
        <View style={styles.reason}>
          <Text variant="small" tone="soft" numberOfLines={2}>
            {`“${row.reason}”`}
          </Text>
        </View>

        <View style={styles.foot}>
          <Text variant="tiny" tone="faint">
            {open ? 'If you accept' : row.status === 'approved' ? 'Refunded' : 'Would have been'}
          </Text>
          <Text style={styles.amount}>{ghs(row.refundPesewas)}</Text>
        </View>
        {open ? (
          <Text variant="tiny" tone="accent">
            {`${ghs(row.merchantLosesPesewas)} comes back off your balance.`}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: {
    backgroundColor: color.surface,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  chips: { paddingHorizontal: space.lg },

  body: { padding: space.lg, gap: space.md },
  pressed: { opacity: 0.75 },
  card: { gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  reference: { flex: 1 },
  reason: {
    backgroundColor: color.surfaceSunk,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  foot: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  amount: { fontFamily: font.bold, fontSize: 16, color: color.ink, letterSpacing: -0.4 },
});
