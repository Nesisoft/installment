import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  GRID_WIDTH,
  Icon,
  Loading,
  Pill,
  QuotedProductCard,
  Screen,
  Text,
} from '../../src/components';
import { useHomeFeed } from '../../src/features/storefront';
import {
  useCredit,
  useNextInstallment,
  useToggleWishlist,
  useWishlistIds,
} from '../../src/features/account';
import { ghs } from '../../src/lib/format';
import { countdown, relativeDate } from '../../src/lib/dates';
import { DEFAULT_CITY } from '../../src/lib/config';
import { color, radius, space } from '../../src/theme/tokens';
import type { StorefrontProduct } from '../../src/features/types';

export default function HomeScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { signedIn } = useAuth();
  const feed = useHomeFeed();
  const nextDue = useNextInstallment(signedIn);
  const credit = useCredit(signedIn);
  const wishlist = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();

  const saved = new Set(wishlist.data ?? []);

  return (
    <Screen tabBar refreshing={feed.isRefetching} onRefresh={() => void feed.refetch()}>
      {/* Header sits on ink, like the design's dark home chrome. */}
      <View style={[styles.header, { paddingTop: insets.top + space.md }]}>
        <View style={styles.headerRow}>
          <View>
            <Text variant="eyebrow" tone="onDarkFaint">
              DELIVER TO
            </Text>
            <Text variant="bodyMedium" tone="onDark">
              {DEFAULT_CITY}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {signedIn ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open your wallet and payments"
                onPress={() => router.push('/wallet')}
                style={styles.walletChip}
              >
                <Text variant="eyebrow" tone="onDarkFaint">
                  LIMIT LEFT
                </Text>
                <Text variant="smallMedium" tone="onDark">
                  {credit.data ? ghs(credit.data.available_pesewas) : '—'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Notifications"
              hitSlop={10}
              onPress={() => router.push('/account')}
            >
              <Icon name="bell" size={19} color={color.onDark} />
            </Pressable>
          </View>
        </View>

        <Pressable
          accessibilityRole="search"
          accessibilityLabel="Search products"
          onPress={() => router.push('/search')}
          style={styles.searchBar}
        >
          <Icon name="search" size={17} color={color.muted} />
          <Text variant="small" tone="muted">
            Search the marketplace
          </Text>
        </Pressable>
      </View>

      {feed.isPending ? <Loading /> : null}
      {feed.isError ? (
        <ErrorState
          message="We couldn't load the shop just now."
          onRetry={() => void feed.refetch()}
        />
      ) : null}

      {feed.data ? (
        <View style={styles.body}>
          <HeroBanner />

          {/* An instalment due gets the first slot below the hero: it is the one
              thing on this screen with a deadline attached to it. */}
          {signedIn && nextDue.data ? <DueStrip installment={nextDue.data} /> : null}

          <CategoryRail categories={feed.data.categories} />

          {feed.data.deals.length > 0 ? (
            <DealsRail
              products={feed.data.deals}
              endsAt={feed.data.deals_end_at}
              saved={saved}
              onToggleSave={(id) => toggleSave.mutate({ productId: id, saved: saved.has(id) })}
              canSave={signedIn}
            />
          ) : null}

          <ProductGrid
            title="Pay in instalments, take it home"
            products={feed.data.installment_picks}
            saved={saved}
            onToggleSave={(id) => toggleSave.mutate({ productId: id, saved: saved.has(id) })}
            canSave={signedIn}
          />

          {feed.data.newest.length > 0 ? (
            <ProductGrid
              title="New in"
              products={feed.data.newest}
              saved={saved}
              onToggleSave={(id) => toggleSave.mutate({ productId: id, saved: saved.has(id) })}
              canSave={signedIn}
            />
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

function HeroBanner(): React.ReactElement {
  return (
    <View style={styles.hero}>
      <Text variant="eyebrow" tone="accent">
        BUY NOW · PAY LATER
      </Text>
      <Text variant="h1" tone="onDark" style={styles.heroTitle}>
        Everything you want.{'\n'}Pay small small.
      </Text>
      <Text variant="small" tone="onDarkMuted" style={styles.heroBody}>
        Split an order across weekly payments on Mobile Money. See the exact schedule before you
        commit — no surprises.
      </Text>
      <Button
        label="Shop instalment items"
        variant="primary"
        full={false}
        compact
        style={styles.heroCta}
        onPress={() => router.push('/browse?installment_only=true')}
      />
    </View>
  );
}

/** "GHS 583 due Fri 29 Aug · instalment 2 of 4" — with a way to pay it. */
function DueStrip({
  installment,
}: {
  installment: NonNullable<ReturnType<typeof useNextInstallment>['data']>;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ghs(installment.payable_pesewas)} due ${relativeDate(installment.due_date)}. Open your instalments.`}
      onPress={() => router.push('/plans')}
    >
      <Card dark style={styles.dueCard}>
        <View style={styles.dueIcon}>
          <Icon name="card" size={19} color={color.onDark} />
        </View>
        <View style={styles.dueText}>
          <Text variant="bodyMedium" tone="onDark">
            {ghs(installment.payable_pesewas)} due {relativeDate(installment.due_date)}
          </Text>
          <Text variant="tiny" tone="onDarkMuted" numberOfLines={1}>
            Instalment {installment.position} of {installment.total_installments}
            {installment.item_title ? ` · ${installment.item_title}` : ''}
          </Text>
        </View>
        <Pill
          label={installment.is_overdue ? 'OVERDUE' : 'PAY'}
          tone={installment.is_overdue ? 'accent' : 'onDark'}
        />
      </Card>
    </Pressable>
  );
}

function CategoryRail({
  categories,
}: {
  categories: { id: string; name: string; slug: string; accent_hex: string | null }[];
}): React.ReactElement | null {
  if (categories.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
    >
      {categories.map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          accessibilityLabel={`Browse ${c.name}`}
          onPress={() => router.push(`/browse?category_slug=${c.slug}`)}
          style={styles.category}
        >
          <View
            style={[styles.categoryTile, { backgroundColor: c.accent_hex ?? color.surfaceSunk }]}
          />
          <Text variant="tiny" numberOfLines={1}>
            {c.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function DealsRail({
  products,
  endsAt,
  saved,
  onToggleSave,
  canSave,
}: {
  products: StorefrontProduct[];
  endsAt: string | null;
  saved: Set<string>;
  onToggleSave: (id: string) => void;
  canSave: boolean;
}): React.ReactElement {
  const [remaining, setRemaining] = useState(() => countdown(endsAt));

  useEffect(() => {
    if (!endsAt) return;
    const timer = setInterval(() => setRemaining(countdown(endsAt)), 1_000);
    return () => clearInterval(timer);
  }, [endsAt]);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionTitleRow}>
          <Text variant="h3">Deals</Text>
          {/* The timer tracks the SOONEST expiry in the rail: a single countdown
              over a mixed carousel has to end when the first deal does. */}
          {remaining ? <Pill label={remaining} tone="accent" /> : null}
        </View>
        <Pressable onPress={() => router.push('/browse?deals=1')} accessibilityRole="button">
          <Text variant="smallMedium" tone="accent">
            See all
          </Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        {products.map((p) => (
          <QuotedProductCard
            key={p.id}
            product={p}
            width={150}
            compact
            saved={saved.has(p.id)}
            onToggleSave={canSave ? () => onToggleSave(p.id) : undefined}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function ProductGrid({
  title,
  products,
  saved,
  onToggleSave,
  canSave,
}: {
  title: string;
  products: StorefrontProduct[];
  saved: Set<string>;
  onToggleSave: (id: string) => void;
  canSave: boolean;
}): React.ReactElement | null {
  if (products.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text variant="h3" style={styles.gridTitle}>
        {title}
      </Text>
      <View style={styles.grid}>
        {products.map((p) => (
          <QuotedProductCard
            key={p.id}
            product={p}
            width={GRID_WIDTH}
            saved={saved.has(p.id)}
            onToggleSave={canSave ? () => onToggleSave(p.id) : undefined}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * Two columns with a gutter, measured rather than flexed.
 *
 * `flex: 1` inside a wrapping row does not produce a grid — the last row of an
 * odd-length list stretches its single card to full width. An explicit width
 * keeps every tile the same size whatever the count.
 */

const styles = StyleSheet.create({
  header: {
    backgroundColor: color.dark,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  walletChip: {
    backgroundColor: color.darkRaised,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 13,
  },
  body: { gap: space.xxl, paddingTop: space.lg },
  hero: {
    marginHorizontal: space.lg,
    backgroundColor: color.darkRaised,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.sm,
  },
  heroTitle: { marginTop: 6 },
  heroBody: { marginTop: 2 },
  heroCta: { marginTop: space.md, alignSelf: 'flex-start' },
  dueCard: {
    marginHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  dueIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: color.darkHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dueText: { flex: 1, gap: 2 },
  rail: { gap: space.md, paddingHorizontal: space.lg },
  category: { alignItems: 'center', gap: 6, width: 62 },
  categoryTile: { width: 56, height: 56, borderRadius: radius.md },
  section: { gap: space.md },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  gridTitle: { paddingHorizontal: space.lg },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
});
