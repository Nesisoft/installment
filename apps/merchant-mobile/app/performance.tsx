import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantStatsByPaymentType, MerchantStatsWindow } from '@installment/api-types';
import {
  Card,
  ErrorState,
  Header,
  Loading,
  Note,
  Screen,
  SectionLabel,
  Segmented,
  Sparkline,
  StatTile,
  StatusDot,
  Text,
  type SegmentOption,
} from '../src/components';
import { useMerchantStats } from '../src/features/merchant';
import { cedis, ghs, pluralise, signedPct } from '../src/lib/format';
import { shortDay } from '../src/lib/today';
import { color, font, space } from '../src/theme/tokens';

const WINDOWS: SegmentOption<`${MerchantStatsWindow}`>[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export default function PerformanceScreen(): React.ReactElement {
  const [window, setWindow] = useState<`${MerchantStatsWindow}`>('30');
  const days = Number(window) as MerchantStatsWindow;
  const stats = useMerchantStats(days);

  const refresh = useCallback(() => {
    void stats.refetch();
  }, [stats]);

  return (
    <Screen refreshing={stats.isFetching} onRefresh={refresh}>
      <Header back title="Performance" />
      <View style={styles.body}>
        <Segmented scroll={false} options={WINDOWS} value={window} onChange={setWindow} />

        {stats.isPending ? (
          <Loading />
        ) : stats.error ? (
          <ErrorState
            message={apiErrorMessage(stats.error, 'Could not load your figures.')}
            onRetry={refresh}
          />
        ) : (
          <>
            <View style={styles.tiles}>
              <StatTile
                tone="primary"
                eyebrow="Sold"
                value={ghs(stats.data.current.grossSoldPesewas)}
                sub={movement(stats.data.change.grossSoldPct)}
              />
              <StatTile
                tone="muted"
                eyebrow="Settled to you"
                value={ghs(stats.data.current.netEarnedPesewas)}
                sub="After fees and reserve"
              />
            </View>
            <View style={styles.tiles}>
              <StatTile
                tone="info"
                eyebrow="Orders"
                value={String(stats.data.current.orders)}
                sub={movement(stats.data.change.ordersPct)}
              />
              <StatTile
                tone="warn"
                eyebrow="Average basket"
                value={ghs(stats.data.current.averageBasketPesewas)}
                sub={movement(stats.data.change.averageBasketPct)}
              />
            </View>

            <Card>
              <Text variant="h3">Sales by day</Text>
              {stats.data.daily.length > 0 ? (
                <>
                  <Sparkline
                    dark={false}
                    highlightLast={false}
                    height={96}
                    bars={stats.data.daily.map((d) => ({
                      date: d.date,
                      value: d.grossSoldPesewas,
                    }))}
                    style={styles.chart}
                    accessibilityLabel={`Sales for each of the last ${stats.data.daily.length} days`}
                  />
                  <View style={styles.axis}>
                    <Text variant="tiny" tone="faint">
                      {shortDay(stats.data.daily[0]!.date)}
                    </Text>
                    <Text variant="tiny" tone="faint">
                      {shortDay(stats.data.daily[stats.data.daily.length - 1]!.date)}
                    </Text>
                  </View>
                </>
              ) : null}
              {stats.data.current.orders === 0 ? (
                <Text variant="tiny" tone="faint" style={styles.flat}>
                  {/* Every day in the window comes back, zeroes included, so a
                      flat chart is a real answer and not a missing one. Saying
                      so stops it reading as a chart that failed to load. */}
                  Nothing sold in this window. Every day is shown, so the flat line is the answer,
                  not a missing one.
                </Text>
              ) : null}
            </Card>

            <View>
              <SectionLabel>How customers paid</SectionLabel>
              <PaymentMix
                installment={stats.data.current.paymentMix.installment}
                full={stats.data.current.paymentMix.full}
              />
            </View>

            {stats.data.current.cancelledOrders > 0 ? (
              <Note eyebrow="Abandoned checkouts">
                {`${pluralise(stats.data.current.cancelledOrders, 'checkout')} worth ${ghs(
                  stats.data.current.cancelledValuePesewas,
                )} were started and never paid for. A paid order cannot be cancelled — those are refunds, and they are not counted here.`}
              </Note>
            ) : null}

            <Note eyebrow="Credited in this window">
              {`${ghs(
                stats.data.current.creditedPesewas,
              )} landed in your account during this window, whatever it was for. It will not match "settled to you" — reserve released this week belongs to a sale from months ago.`}
            </Note>
          </>
        )}
      </View>
    </Screen>
  );
}

/**
 * The change line under a tile.
 *
 * `null` from the API means the previous window was zero, and there is no
 * percentage change from nothing — so the line says there is nothing to compare
 * against rather than printing a number.
 */
function movement(pct: number | null): string {
  const signed = signedPct(pct);
  return signed === null ? 'No earlier period to compare' : `${signed} vs the window before`;
}

/**
 * Instalments against paid outright.
 *
 * The two sides always add up to the headline above, because the API derives
 * them from the same rows — a mix that did not reconcile would be worse than no
 * mix at all. `shareOfOrdersPct` is null when the window sold nothing, which is
 * why the bar is not drawn then: a share of no orders is undefined, not 0%.
 */
function PaymentMix({
  installment,
  full,
}: {
  installment: MerchantStatsByPaymentType;
  full: MerchantStatsByPaymentType;
}): React.ReactElement {
  const total = installment.orders + full.orders;

  if (total === 0) {
    return (
      <Card>
        <Text variant="smallMedium">No orders in this window</Text>
        <Text variant="tiny" tone="faint" style={styles.mixNote}>
          The split appears once something sells.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      {/* Pixel-free: both fills are flex weights over the same row, so the bar
          is a share of the two and cannot resolve against a zero-height parent
          the way a percentage would. */}
      <View style={styles.track}>
        {installment.orders > 0 ? (
          <View
            style={[styles.fill, { flex: installment.orders, backgroundColor: color.primary }]}
          />
        ) : null}
        {full.orders > 0 ? (
          <View style={[styles.fill, { flex: full.orders, backgroundColor: color.ink }]} />
        ) : null}
      </View>

      <MixRow
        tone="primary"
        label="Paid over time"
        side={installment}
        note="Ejua lends and collects; you are credited per your plan type"
      />
      <MixRow
        tone="muted"
        label="Paid outright"
        side={full}
        note="Settled to you less the marketplace commission"
      />
    </Card>
  );
}

function MixRow({
  tone,
  label,
  side,
  note,
}: {
  tone: 'primary' | 'muted';
  label: string;
  side: MerchantStatsByPaymentType;
  note: string;
}): React.ReactElement {
  return (
    <View style={styles.mixRow}>
      <StatusDot tone={tone === 'primary' ? 'primary' : 'muted'} style={styles.mixDot} />
      <View style={styles.mixText}>
        <Text variant="smallMedium">
          {`${side.shareOfOrdersPct ?? 0}% · ${pluralise(side.orders, 'order')}`}
        </Text>
        <Text variant="tiny" tone="faint">
          {label}
        </Text>
        <Text variant="tiny" tone="faint" style={styles.mixNote}>
          {side.orders === 0 ? note : `${note} · ${ghs(side.averageBasketPesewas)} average basket`}
        </Text>
      </View>
      <Text style={styles.mixValue}>{cedis(side.grossSoldPesewas)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg },
  tiles: { flexDirection: 'row', gap: space.md },

  chart: { marginTop: space.lg },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  flat: { marginTop: space.md, lineHeight: 16 },

  track: {
    flexDirection: 'row',
    height: 9,
    borderRadius: 5,
    overflow: 'hidden',
    gap: 2,
    marginBottom: space.md,
    backgroundColor: color.surfaceSunk,
  },
  fill: { height: 9, borderRadius: 5 },

  mixRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: 7 },
  mixDot: { marginTop: 6 },
  mixText: { flex: 1 },
  mixNote: { marginTop: 1, lineHeight: 15 },
  mixValue: { fontFamily: font.bold, fontSize: 14.5, color: color.ink, letterSpacing: -0.2 },
});
