import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantStatsTopProduct } from '@installment/api-types';
import {
  ActionRow,
  Avatar,
  Card,
  ErrorState,
  Icon,
  Loading,
  MoneyRow,
  Screen,
  SectionLabel,
  Sparkline,
  Text,
} from '../../src/components';
import {
  useCatalogSummary,
  useMerchantBalances,
  useMerchantProfile,
  useMerchantStats,
  useOrdersAwaitingConfirmation,
} from '../../src/features/merchant';
import { cedis, ghs, initials, pluralise, signedPct } from '../../src/lib/format';
import { lastDays, latestDay, shortDay, vsSameWeekday } from '../../src/lib/today';
import { color, font, radius, space, tintFor } from '../../src/theme/tokens';

/** The design draws two weeks of bars in the hero. */
const HERO_DAYS = 14;

export default function TodayScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const profile = useMerchantProfile();
  // 30 days, not 7: `vsSameWeekday` reaches back eight days, and the bars are
  // sliced from the same response rather than fetched again.
  const stats = useMerchantStats(30);
  const balances = useMerchantBalances();
  const catalog = useCatalogSummary();
  const awaiting = useOrdersAwaitingConfirmation();

  const refreshing =
    stats.isFetching || balances.isFetching || awaiting.isFetching || catalog.isFetching;

  const refresh = useCallback(() => {
    void stats.refetch();
    void balances.refetch();
    void awaiting.refetch();
    void catalog.refetch();
    void profile.refetch();
  }, [stats, balances, awaiting, catalog, profile]);

  if (stats.isPending || balances.isPending) {
    return (
      <Screen tabBar>
        <Loading />
      </Screen>
    );
  }

  if (stats.error || balances.error) {
    return (
      <Screen tabBar>
        <ErrorState
          message={apiErrorMessage(stats.error ?? balances.error, 'Could not load your shop.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const today = latestDay(stats.data.daily);
  const movement = vsSameWeekday(stats.data.daily);
  const bars = lastDays(stats.data.daily, HERO_DAYS);
  const shopName = profile.data?.business_name ?? 'Your shop';

  return (
    <Screen tabBar refreshing={refreshing} onRefresh={refresh}>
      {/* Hero. Dark, edge to edge, and it owns the status-bar inset itself so
          the money sits on the dark ground rather than under a light bar. */}
      <View style={[styles.hero, { paddingTop: insets.top + space.md }]}>
        <View style={styles.shopRow}>
          <Avatar initials={initials(shopName)} />
          <View style={styles.shopText}>
            <Text variant="h3" tone="onDark" numberOfLines={1}>
              {shopName}
            </Text>
            <Text variant="tiny" tone="onDarkMuted" numberOfLines={1}>
              {profile.data?.status === 'active' ? 'Verified' : (profile.data?.status ?? '—')}
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sold ${today ? shortDay(today.date) : 'today'}, ${ghs(
            today?.grossSoldPesewas ?? 0,
          )}. See your full performance.`}
          onPress={() => router.push('/performance')}
          style={({ pressed }) => (pressed ? styles.pressed : null)}
        >
          <Card dark bare style={styles.heroCard}>
            <View style={styles.heroHead}>
              <Text variant="eyebrow" tone="onDarkFaint">
                {today ? `SOLD ${shortDay(today.date).toUpperCase()}` : 'SOLD TODAY'}
              </Text>
              {movement ? (
                <Text
                  variant="tiny"
                  tone={movement.pct >= 0 ? 'primary' : 'accent'}
                  style={styles.movement}
                >
                  {`${signedPct(movement.pct)} vs last ${movement.weekday}`}
                </Text>
              ) : null}
            </View>
            <Text variant="display" tone="onDark" style={styles.heroValue}>
              {ghs(today?.grossSoldPesewas ?? 0)}
            </Text>
            <Text variant="small" tone="onDarkMuted">
              {pluralise(today?.orders ?? 0, 'order')}
              {stats.data.current.paymentMix.installment.orders > 0
                ? ` · ${stats.data.current.paymentMix.installment.orders} on instalments this month`
                : ''}
            </Text>

            {bars.length > 0 ? (
              <>
                <Sparkline
                  bars={bars.map((d) => ({ date: d.date, value: d.grossSoldPesewas }))}
                  style={styles.spark}
                  accessibilityLabel={`Sales for the last ${bars.length} days`}
                />
                <View style={styles.sparkAxis}>
                  <Text variant="tiny" tone="onDarkFaint">
                    {shortDay(bars[0]!.date)}
                  </Text>
                  <Text variant="tiny" tone="onDarkFaint">
                    {shortDay(bars[bars.length - 1]!.date)}
                  </Text>
                </View>
              </>
            ) : null}
          </Card>
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={styles.quickRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="List a product"
            onPress={() => router.push('/products')}
            style={({ pressed }) => [styles.quickPrimary, pressed && styles.pressed]}
          >
            <Icon name="plus" size={20} color={color.onDark} />
            <View>
              <Text variant="smallMedium" tone="onDark">
                List a product
              </Text>
              <Text variant="tiny" tone="onDark" style={styles.quickSub}>
                Live in 2 minutes
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Payable now, ${ghs(balances.data.payablePesewas)}`}
            onPress={() => router.push('/payouts')}
            style={({ pressed }) => [styles.quickSecondary, pressed && styles.pressed]}
          >
            <Icon name="card" size={18} color={color.ink} />
            <View>
              <Text variant="smallMedium">{ghs(balances.data.payablePesewas)}</Text>
              <Text variant="tiny" tone="faint">
                {balances.data.payablePesewas > 0 ? 'Paying out tonight' : 'Nothing due tonight'}
              </Text>
            </View>
          </Pressable>
        </View>

        <SectionLabel style={styles.section}>Needs your action</SectionLabel>
        <View style={styles.actions}>
          {(awaiting.data?.total ?? 0) > 0 ? (
            <ActionRow
              count={awaiting.data!.total}
              title={`New ${awaiting.data!.total === 1 ? 'order' : 'orders'} to confirm`}
              body="Already paid to you — confirm so the customer knows it is coming"
              tone="accent"
              onPress={() => router.push('/orders')}
            />
          ) : null}
          {(catalog.data?.outOfStockVariants ?? 0) > 0 ? (
            <ActionRow
              count={catalog.data!.outOfStockVariants}
              title={`${catalog.data!.outOfStockVariants === 1 ? 'Variant' : 'Variants'} out of stock`}
              body="Hidden from customers until you restock"
              tone="warn"
              onPress={() => router.push('/products')}
            />
          ) : null}
          {balances.data.activePlans > 0 ? (
            <ActionRow
              count={balances.data.activePlans}
              title="Active instalment plans"
              body={`Ejua is collecting · ${ghs(balances.data.reserveHeldPesewas)} reserve tied up`}
              tone="info"
              onPress={() => router.push('/plans')}
            />
          ) : null}
          {noActions(
            awaiting.data?.total,
            catalog.data?.outOfStockVariants,
            balances.data.activePlans,
          ) ? (
            <Card style={styles.clear}>
              <Text variant="smallMedium">Nothing waiting on you</Text>
              <Text variant="tiny" tone="faint" style={styles.clearSub}>
                Every order is confirmed and nothing is out of stock.
              </Text>
            </Card>
          ) : null}
        </View>

        <Card style={styles.balances}>
          <Text variant="h3">Your balances</Text>
          <View style={styles.balanceBar}>
            <SplitBar
              payable={balances.data.payablePesewas}
              reserve={balances.data.reserveHeldPesewas}
            />
          </View>
          <MoneyRow
            tone="primary"
            label="Payable now"
            sub="Goes out in tonight's payout run"
            value={ghs(balances.data.payablePesewas)}
          />
          <MoneyRow
            divided
            tone="warn"
            label="Reserve held"
            sub={`Across ${pluralise(balances.data.openReservesCount, 'open plan')}`}
            value={ghs(balances.data.reserveHeldPesewas)}
          />
          <MoneyRow
            divided
            tone="muted"
            label="Lifetime settled"
            sub="Everything paid out to you so far"
            value={ghs(balances.data.lifetimeSettledPesewas)}
          />
          <MoneyRow
            divided
            tone="info"
            label="Active plans"
            sub="Ejua carries the collection risk"
            value={String(balances.data.activePlans)}
          />
        </Card>

        {stats.data.topProducts.length > 0 ? (
          <>
            <SectionLabel style={styles.section}>Best sellers · last 30 days</SectionLabel>
            <Card bare style={styles.sellers}>
              {stats.data.topProducts.map((product, i) => (
                <TopProduct
                  key={product.productId ?? product.title}
                  product={product}
                  divided={i > 0}
                />
              ))}
            </Card>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

/** True only when every count has loaded and every one of them is zero. */
function noActions(...counts: (number | undefined)[]): boolean {
  return counts.every((n) => n !== undefined && n === 0);
}

/**
 * Payable against reserve, as one bar.
 *
 * The two are the whole of what the ledger holds for this merchant, so the bar
 * is a share of their sum and not of some target. Renders nothing when both are
 * zero: a full-width empty track reads as "0% of something", and there is no
 * something.
 */
function SplitBar({
  payable,
  reserve,
}: {
  payable: number;
  reserve: number;
}): React.ReactElement | null {
  const total = payable + reserve;
  if (total <= 0) return null;
  return (
    <View style={styles.track}>
      <View style={[styles.trackFill, { flex: payable, backgroundColor: color.primary }]} />
      <View style={[styles.trackFill, { flex: reserve, backgroundColor: color.warn }]} />
    </View>
  );
}

function TopProduct({
  product,
  divided,
}: {
  product: MerchantStatsTopProduct;
  divided: boolean;
}): React.ReactElement {
  const stock =
    product.stockAvailable === null
      ? 'no longer listed'
      : product.stockAvailable === 0
        ? 'out of stock'
        : `${product.stockAvailable} left`;
  return (
    <View style={[styles.seller, divided && styles.sellerDivided]}>
      <View
        style={[styles.swatch, { backgroundColor: tintFor(product.productId ?? product.title) }]}
      />
      <View style={styles.sellerText}>
        <Text variant="smallMedium" numberOfLines={1}>
          {product.title}
        </Text>
        <Text variant="tiny" tone="faint">
          {`${pluralise(product.unitsSold, 'sold', 'sold')} · ${stock}`}
        </Text>
      </View>
      <Text style={styles.sellerValue}>{cedis(product.grossSoldPesewas)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: color.darkCanvas, paddingHorizontal: space.lg, paddingBottom: space.lg },
  shopRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg },
  shopText: { flex: 1 },
  heroCard: { padding: space.lg, backgroundColor: color.darkRaised },
  heroHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  movement: { fontFamily: font.semibold },
  heroValue: { marginTop: space.sm, marginBottom: 2 },
  spark: { marginTop: space.lg },
  sparkAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },

  body: { padding: space.lg, gap: space.lg },
  quickRow: { flexDirection: 'row', gap: space.md },
  quickPrimary: {
    flex: 1.15,
    gap: space.md,
    backgroundColor: color.primary,
    borderRadius: radius.md,
    padding: space.lg,
    justifyContent: 'space-between',
    minHeight: 104,
  },
  quickSecondary: {
    flex: 1,
    gap: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderSoft,
    borderRadius: radius.md,
    padding: space.lg,
    justifyContent: 'space-between',
    minHeight: 104,
  },
  quickSub: { opacity: 0.85 },
  pressed: { opacity: 0.85 },

  section: { marginBottom: -space.sm },
  actions: { gap: space.sm },
  clear: { paddingVertical: space.md },
  clearSub: { marginTop: 2 },

  balances: { gap: 0 },
  balanceBar: { marginTop: space.md, marginBottom: space.sm },
  track: { flexDirection: 'row', height: 7, borderRadius: 4, overflow: 'hidden', gap: 2 },
  trackFill: { height: 7, borderRadius: 4 },

  sellers: { paddingHorizontal: space.lg },
  seller: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  sellerDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  swatch: { width: 38, height: 38, borderRadius: radius.sm },
  sellerText: { flex: 1 },
  sellerValue: { fontFamily: font.bold, fontSize: 14.5, color: color.ink, letterSpacing: -0.2 },
});
