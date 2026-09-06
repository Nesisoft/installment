import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantPlanBucket, MerchantPlanRow } from '@installment/api-types';
import {
  Avatar,
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  Loading,
  Note,
  PlanStatusPill,
  Screen,
  Segmented,
  Text,
  type SegmentOption,
} from '../../src/components';
import { useMerchantBalances, usePlanCounts, usePlans } from '../../src/features/merchant';
import { shortDate } from '../../src/lib/dates';
import { cedis, ghs, initials, pluralise } from '../../src/lib/format';
import { color, font, space } from '../../src/theme/tokens';

const CHIPS: { value: MerchantPlanBucket; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'late', label: 'Late' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const EMPTY: Record<MerchantPlanBucket, { title: string; body: string }> = {
  active: {
    title: 'Nothing being collected',
    body: 'A plan appears here when a customer buys on instalments and Ejua approves it.',
  },
  late: {
    title: 'Nobody is behind',
    body: 'Every payment Ejua is collecting on your sales is on schedule.',
  },
  completed: {
    title: 'No plan has finished yet',
    body: 'A plan moves here once the customer has paid all of it.',
  },
  all: {
    title: 'No instalment sales yet',
    body: 'Allow instalments on a product and plans will appear here as customers buy.',
  },
};

export default function PlansScreen(): React.ReactElement {
  const [bucket, setBucket] = useState<MerchantPlanBucket>('active');
  const plans = usePlans(bucket);
  const counts = usePlanCounts();
  const balances = useMerchantBalances();

  const refresh = useCallback(() => {
    void plans.refetch();
    void counts.refetch();
    void balances.refetch();
  }, [plans, counts, balances]);

  const options: SegmentOption<MerchantPlanBucket>[] = CHIPS.map((chip) => ({
    ...chip,
    count: counts.data?.[chip.value],
  }));

  const header = (
    <View style={styles.top}>
      <Header back flush title="Instalment plans" />
      <Segmented options={options} value={bucket} onChange={setBucket} style={styles.chips} />
    </View>
  );

  if (plans.isPending) {
    return (
      <Screen>
        {header}
        <Loading />
      </Screen>
    );
  }

  if (plans.error) {
    return (
      <Screen>
        {header}
        <ErrorState
          message={apiErrorMessage(plans.error, 'Could not load your plans.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const rows = plans.data?.rows ?? [];
  const empty = EMPTY[bucket];

  return (
    <Screen refreshing={plans.isFetching} onRefresh={refresh}>
      {header}
      <View style={styles.body}>
        {balances.data && balances.data.reserveHeldPesewas > 0 ? (
          <Card style={styles.reserve}>
            <Text variant="eyebrow" tone="faint">
              RESERVE TIED TO OPEN PLANS
            </Text>
            <Text variant="h1" style={styles.reserveValue}>
              {ghs(balances.data.reserveHeldPesewas)}
            </Text>
            <Text variant="tiny" tone="faint" style={styles.reserveNote}>
              {/* The canvas says "Customer arrears never reduce it." That is
                  false: a default allocates the loss against the reserve, and
                  both this figure and the per-plan one net it off. */}
              {`Held across ${pluralise(balances.data.openReservesCount, 'open plan')}. Each plan's share is released after that plan completes — and a default can eat into it, which is what it is for.`}
            </Text>
          </Card>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={<Icon name="card" size={30} color={color.mutedSoft} />}
            title={empty.title}
            body={empty.body}
          />
        ) : (
          rows.map((row) => <PlanCard key={row.id} row={row} />)
        )}

        {rows.length > 0 ? (
          <Note eyebrow="Who carries the risk">
            Ejua lends the customer the money and collects every payment. You were credited per your
            plan type, and a payment the customer misses does not claw that back.
          </Note>
        ) : null}
      </View>
    </Screen>
  );
}

function PlanCard({ row }: { row: MerchantPlanRow }): React.ReactElement {
  const name = row.customerName ?? 'Customer';
  const spoken = [
    row.orderNumber ?? 'Plan',
    row.itemSummary ?? '',
    `for ${name}`,
    `${row.paidCount} of ${row.installmentCount} paid`,
    `${ghs(row.collectedPesewas)} collected of ${ghs(row.totalPayablePesewas)}`,
    row.late ? 'behind on a payment' : '',
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={() => router.push(`/plans/${row.id}`)}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <Text variant="eyebrowLg" tone="faint" numberOfLines={1} style={styles.reference}>
            {/* No `PL-…` reference exists in this schema — a plan's only
                identifier is a uuid — so the sale's own number names it. */}
            {row.orderNumber ?? 'Order no longer on file'}
          </Text>
          <PlanStatusPill status={row.status} late={row.late} />
        </View>

        <View style={styles.who}>
          <Avatar
            initials={initials(name)}
            size={34}
            background={color.surfaceSunk}
            foreground={color.inkSoft}
          />
          <View style={styles.whoText}>
            <Text variant="smallMedium" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="tiny" tone="faint" numberOfLines={1}>
              {row.itemSummary ?? 'Item no longer on file'}
            </Text>
          </View>
          <Text style={styles.total}>{ghs(row.orderAmountPesewas)}</Text>
        </View>

        {/* Flex weights, not percentages: a percentage against a parent whose
            height is content-derived resolves to zero. */}
        <View style={styles.track}>
          <View style={[styles.fill, { flex: Math.max(row.paidCount, 0) }]} />
          <View
            style={[styles.rest, { flex: Math.max(row.installmentCount - row.paidCount, 0) }]}
          />
        </View>

        <View style={styles.foot}>
          <Text variant="tiny" tone="faint">
            {`${row.paidCount} of ${row.installmentCount} paid · ${cedis(row.collectedPesewas)} collected`}
          </Text>
          <Text variant="tiny" tone={row.late ? 'accent' : 'faint'}>
            {row.nextDueDate
              ? `${row.late ? 'Overdue since' : 'Next'} ${shortDate(row.nextDueDate)}`
              : 'Nothing left to collect'}
          </Text>
        </View>
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
  reserve: { gap: 2 },
  reserveValue: { marginTop: 2 },
  reserveNote: { marginTop: space.xs, lineHeight: 16 },

  pressed: { opacity: 0.75 },
  card: { gap: space.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  reference: { flex: 1 },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  whoText: { flex: 1 },
  total: { fontFamily: font.bold, fontSize: 15, color: color.ink, letterSpacing: -0.3 },

  track: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', gap: 2 },
  fill: { backgroundColor: color.primary, borderRadius: 3 },
  rest: { backgroundColor: color.surfaceSunk, borderRadius: 3 },

  foot: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
});
