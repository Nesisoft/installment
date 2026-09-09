import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@installment/mobile-kit';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  GRID_WIDTH,
  Header,
  Icon,
  ListFooter,
  Loading,
  QuotedProductCard,
  Screen,
  SectionLabel,
  Sheet,
  Text,
} from '../../src/components';
import {
  SORTS,
  useBrowse,
  useCategories,
  type BrowseFilters,
  type SortValue,
} from '../../src/features/storefront';
import { useToggleWishlist, useWishlistIds } from '../../src/features/account';
import { ghs, pluralise } from '../../src/lib/format';
import { color, font, radius, space } from '../../src/theme/tokens';

/**
 * The PAYMENT group is single-select: "Pay in instalments" and "In stock" are
 * the two narrowings the catalogue supports, and offering them as a pair of
 * independent switches would imply combinations the shelf cannot express.
 */
const PAYMENTS = [
  { value: 'all', label: 'All' },
  { value: 'installment', label: 'Pay in instalments' },
  { value: 'in_stock', label: 'In stock' },
] as const;

type PaymentValue = (typeof PAYMENTS)[number]['value'];

/** Ceilings in pesewas — GHS 500 / 1,000 / 3,000. Labels are formatted, never typed out. */
const PRICE_BANDS = [50_000, 100_000, 300_000] as const;

interface Filters {
  category_slug?: string;
  store_id?: string;
  deals_only: boolean;
  sort: SortValue;
  payment: PaymentValue;
  max_price_pesewas?: number;
}

const DEFAULTS: Filters = { deals_only: false, sort: 'popular', payment: 'all' };

export default function BrowseScreen(): React.ReactElement {
  const { signedIn } = useAuth();
  const params = useLocalSearchParams();
  const categories = useCategories();
  const wishlist = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();
  const [sheetOpen, setSheetOpen] = useState(false);

  const paramCategory = firstParam(params.category_slug);
  const paramStore = firstParam(params.store_id);
  const paramInstalments = isTruthyParam(params.installment_only);
  const paramDeals = isTruthyParam(params.deals);

  const [filters, setFilters] = useState<Filters>(() =>
    seed(paramCategory, paramStore, paramInstalments, paramDeals),
  );

  // Browse is a mounted tab, so arriving from a home rail changes the route
  // params under a screen that never unmounts. Re-seeding on that change is
  // what makes "Deals · See all" land on deals rather than on whatever the
  // customer last left the chips set to.
  useEffect(() => {
    setFilters(seed(paramCategory, paramStore, paramInstalments, paramDeals));
  }, [paramCategory, paramStore, paramInstalments, paramDeals]);

  const query = useMemo<BrowseFilters>(
    () => ({
      sort: filters.sort,
      ...(filters.category_slug ? { category_slug: filters.category_slug } : {}),
      ...(filters.store_id ? { store_id: filters.store_id } : {}),
      ...(filters.deals_only ? { deals_only: true } : {}),
      ...(filters.payment === 'installment' ? { installment_only: true } : {}),
      ...(filters.payment === 'in_stock' ? { in_stock: true } : {}),
      ...(filters.max_price_pesewas ? { max_price_pesewas: filters.max_price_pesewas } : {}),
    }),
    [filters],
  );

  const browse = useBrowse(query);
  const rows = browse.data?.rows ?? [];

  /**
   * A filter change keeps the previous page on screen (`placeholderData`), so
   * while one is in flight the loaded total belongs to the *old* filters.
   * Naming it would put a number in front of the customer that the next frame
   * contradicts, so the count simply steps aside until the answer lands.
   */
  const total = browse.isPlaceholderData ? null : (browse.data?.total ?? null);
  const settled = Boolean(browse.data) && !browse.isPlaceholderData;

  const sortLabel = SORTS.find((s) => s.value === filters.sort)?.label ?? SORTS[0].label;
  // Only the three groups the sheet owns are counted: the category is already
  // shown as a selected chip an inch above, and badging it would say the same
  // thing twice.
  const activeCount =
    (filters.sort === DEFAULTS.sort ? 0 : 1) +
    (filters.payment === DEFAULTS.payment ? 0 : 1) +
    (filters.max_price_pesewas ? 1 : 0);

  const categoryName = categories.data?.find((c) => c.slug === filters.category_slug)?.name ?? null;
  // No id → store lookup exists (`useStore` keys off the slug), so a shelf
  // scoped to a store names itself from the rows it got back.
  const storeName = filters.store_id ? (rows[0]?.store_display_name ?? null) : null;

  /**
   * The next thirty.
   *
   * Guarded here rather than in `Screen`: the scroll trigger fires on every
   * approach to the bottom, including the one the reader makes while a page is
   * already in flight and the one they make after the last page has landed.
   */
  function loadMore(): void {
    if (browse.hasNextPage && !browse.isFetchingNextPage) void browse.fetchNextPage();
  }

  const saved = new Set(wishlist.data ?? []);
  const update = (patch: Partial<Filters>): void => setFilters((prev) => ({ ...prev, ...patch }));

  return (
    <Screen
      tabBar
      refreshing={browse.isRefetching}
      onRefresh={() => void browse.refetch()}
      onEndReached={loadMore}
    >
      <Header
        title={categoryName ?? (filters.deals_only ? 'Deals' : 'Browse')}
        subtitle={storeName ?? (filters.deals_only && categoryName ? 'Live deals only' : undefined)}
        right={
          <Pressable
            accessibilityRole="search"
            accessibilityLabel="Search products"
            hitSlop={12}
            onPress={() => router.push('/search')}
          >
            <Icon name="search" size={20} color={color.ink} />
          </Pressable>
        }
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        <Chip
          label="All"
          accessibilityLabel="All categories"
          selected={!filters.category_slug}
          onPress={() => update({ category_slug: undefined })}
        />
        {(categories.data ?? []).map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            selected={filters.category_slug === c.slug}
            onPress={() => update({ category_slug: c.slug })}
          />
        ))}
      </ScrollView>

      <View style={styles.bar}>
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.barCount}>
          {total === null ? sortLabel : `${pluralise(total, 'item')} · ${sortLabel}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            activeCount > 0
              ? `Filter and sort, ${pluralise(activeCount, 'filter')} applied`
              : 'Filter and sort'
          }
          onPress={() => setSheetOpen(true)}
          style={({ pressed }) => [styles.filterButton, { opacity: pressed ? 0.75 : 1 }]}
        >
          <Icon name="sliders" size={15} color={color.ink} />
          <Text variant="smallMedium">Filter</Text>
          {activeCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{activeCount}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {browse.isPending ? <Loading /> : null}

      {browse.isError ? (
        <ErrorState
          message="We couldn't load these items just now."
          onRetry={() => void browse.refetch()}
        />
      ) : null}

      {!browse.isError && settled && rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="grid" size={26} color={color.mutedSoft} />}
          title="Nothing matches that"
          body="No item in the shop fits every filter you picked. Widen one and try again."
          action={
            <Button label="Clear filters" variant="ghost" onPress={() => setFilters(DEFAULTS)} />
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <View style={styles.grid}>
          {rows.map((p) => (
            <QuotedProductCard
              key={p.id}
              product={p}
              width={GRID_WIDTH}
              saved={saved.has(p.id)}
              onToggleSave={
                signedIn
                  ? () => toggleSave.mutate({ productId: p.id, saved: saved.has(p.id) })
                  : undefined
              }
            />
          ))}
        </View>
      ) : null}

      {/* The header has always printed the real total. Until now the grid held
          thirty of it with no way to reach the rest — a category of 218 showed
          "218 items" over 30. */}
      <ListFooter
        shown={rows.length}
        total={total}
        hasMore={Boolean(browse.hasNextPage)}
        loading={browse.isFetchingNextPage}
        onLoadMore={loadMore}
      />

      <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)}>
        <View style={styles.sheetHead}>
          <Text variant="h2">Filter</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close filters"
            hitSlop={12}
            onPress={() => setSheetOpen(false)}
          >
            <Icon name="x" size={20} color={color.inkSoft} />
          </Pressable>
        </View>

        {/* The sheet scrolls in its own right: three wrapped chip groups plus a
            footer overflow a short handset once the system font scale is up. */}
        <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
          <SectionLabel>Sort by</SectionLabel>
          <View style={styles.chipWrap}>
            {SORTS.map((s) => (
              <Chip
                key={s.value}
                label={s.label}
                accessibilityLabel={`Sort by ${s.label}`}
                selected={filters.sort === s.value}
                onPress={() => update({ sort: s.value })}
              />
            ))}
          </View>

          <SectionLabel style={styles.groupLabel}>Payment</SectionLabel>
          <View style={styles.chipWrap}>
            {PAYMENTS.map((p) => (
              <Chip
                key={p.value}
                label={p.label}
                accessibilityLabel={`Payment: ${p.label}`}
                selected={filters.payment === p.value}
                onPress={() => update({ payment: p.value })}
              />
            ))}
          </View>

          <SectionLabel style={styles.groupLabel}>Max price</SectionLabel>
          <View style={styles.chipWrap}>
            <Chip
              label="Any"
              accessibilityLabel="Any price"
              selected={!filters.max_price_pesewas}
              onPress={() => update({ max_price_pesewas: undefined })}
            />
            {PRICE_BANDS.map((band) => (
              <Chip
                key={band}
                label={`Under ${ghs(band)}`}
                selected={filters.max_price_pesewas === band}
                onPress={() => update({ max_price_pesewas: band })}
              />
            ))}
          </View>
        </ScrollView>

        <View style={styles.sheetFooter}>
          {/* Clear resets what this sheet owns. The category chip and the shelf
              the customer arrived on are theirs to change outside it. */}
          <Button
            label="Clear"
            variant="ghost"
            full={false}
            style={styles.footerClear}
            onPress={() =>
              update({
                sort: DEFAULTS.sort,
                payment: DEFAULTS.payment,
                max_price_pesewas: undefined,
              })
            }
          />
          <Button
            label={total === null ? 'Show items' : `Show ${pluralise(total, 'item')}`}
            variant="primary"
            full={false}
            style={styles.footerShow}
            onPress={() => setSheetOpen(false)}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

/** The filter state a set of route params means. */
function seed(
  categorySlug: string | undefined,
  storeId: string | undefined,
  instalmentsOnly: boolean,
  dealsOnly: boolean,
): Filters {
  return {
    ...DEFAULTS,
    ...(categorySlug ? { category_slug: categorySlug } : {}),
    ...(storeId ? { store_id: storeId } : {}),
    deals_only: dealsOnly,
    payment: instalmentsOnly ? 'installment' : 'all',
  };
}

/** A repeated query key arrives as an array; the first value wins. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Matches how the API coerces its own boolean query params. */
function isTruthyParam(value: string | string[] | undefined): boolean {
  const first = firstParam(value);
  return first === 'true' || first === '1';
}

/**
 * Two columns with a gutter, measured rather than flexed.
 *
 * `flex: 1` inside a wrapping row does not produce a grid — the last row of an
 * odd-length list stretches its single card to full width. An explicit width
 * keeps every tile the same size whatever the count.
 */

const styles = StyleSheet.create({
  rail: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  barCount: { flex: 1 },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  badge: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: font.bold, fontSize: 10, color: color.onDark },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  sheetScroll: { flexShrink: 1 },
  groupLabel: { marginTop: space.xl },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sheetFooter: { flexDirection: 'row', gap: space.md, paddingTop: space.xl },
  footerClear: { flex: 1 },
  footerShow: { flex: 1.6 },
});
