import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantProductRow, ProductVariantStock } from '@installment/api-types';
import {
  Button,
  Card,
  EmptyState,
  RestockSheet,
  ErrorState,
  Header,
  Icon,
  Loading,
  Pill,
  Screen,
  Segmented,
  Text,
  type PillTone,
  type SegmentOption,
} from '../../src/components';
import { useCatalog, useCatalogSummary, type CatalogFilter } from '../../src/features/merchant';
import { cedis, pluralise } from '../../src/lib/format';
import { color, font, radius, space, tintFor } from '../../src/theme/tokens';

const EMPTY: Record<CatalogFilter, { title: string; body: string }> = {
  all: {
    title: 'Nothing listed yet',
    body: 'Products you list appear here. Until one is live, customers cannot find your shop.',
  },
  live: {
    title: 'Nothing is live',
    body: 'A draft product is invisible to customers. Publish one to start selling.',
  },
  restock: {
    title: 'Everything is in stock',
    body: 'No live product has a size a customer cannot buy.',
  },
};

export default function ProductsScreen(): React.ReactElement {
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const catalog = useCatalog(filter);
  const summary = useCatalogSummary();

  const refresh = useCallback(() => {
    void catalog.refetch();
    void summary.refetch();
  }, [catalog, summary]);

  // The chips count different things and the labels have to say so. "All" and
  // "Live" count PRODUCTS; the restock chip counts VARIANTS, because a shop
  // with one dress in four empty sizes has one product to fix and four sizes
  // to restock — and a bare "4" beside two product counts would read as four
  // products.
  const chips: SegmentOption<CatalogFilter>[] = [
    { value: 'all', label: 'All', count: summary.data?.products },
    { value: 'live', label: 'Live', count: summary.data?.liveProducts },
    { value: 'restock', label: 'Sizes to restock', count: summary.data?.outOfStockVariants },
  ];

  const header = (
    <View style={styles.top}>
      <Header
        flush
        title="Products"
        right={
          <Button
            label="List one"
            compact
            icon={<Icon name="plus" size={15} color={color.onDark} />}
            onPress={() => router.push('/products/new')}
          />
        }
      />
      <Segmented options={chips} value={filter} onChange={setFilter} style={styles.chips} />
    </View>
  );

  if (catalog.isPending) {
    return (
      <Screen tabBar>
        {header}
        <Loading />
      </Screen>
    );
  }

  if (catalog.error) {
    return (
      <Screen tabBar>
        {header}
        <ErrorState
          message={apiErrorMessage(catalog.error, 'Could not load your catalogue.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const rows = catalog.data ?? [];
  const empty = EMPTY[filter];

  return (
    <Screen tabBar refreshing={catalog.isFetching} onRefresh={refresh}>
      {header}
      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="grid" size={30} color={color.mutedSoft} />}
          title={empty.title}
          body={empty.body}
          action={<Button label="List a product" onPress={() => router.push('/products/new')} />}
        />
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <ProductCard key={row.id} row={row} />
          ))}
        </View>
      )}
    </Screen>
  );
}

/** What a product's stock adds up to across its sizes. */
function stockOf(variants: ProductVariantStock[]): {
  total: number;
  empty: number;
  label: string;
  tone: PillTone;
} {
  const total = variants.reduce((n, v) => n + v.quantity_available, 0);
  const empty = variants.filter((v) => v.quantity_available === 0).length;
  if (variants.length === 0) return { total, empty, label: 'NO SIZES', tone: 'neutral' };
  if (empty === variants.length) return { total, empty, label: 'OUT OF STOCK', tone: 'accent' };
  if (empty > 0) return { total, empty, label: 'PART STOCKED', tone: 'warn' };
  return { total, empty, label: 'IN STOCK', tone: 'primary' };
}

function ProductCard({ row }: { row: MerchantProductRow }): React.ReactElement {
  const stock = stockOf(row.variants);
  const live = row.status === 'active';
  const [restocking, setRestocking] = useState(false);

  return (
    <Card style={styles.card}>
      {/* The card opens the listing; Restock is a sibling of this Pressable,
          never a child. A Pressable inside a Pressable fires both, which is how
          the order card ended up confirming an order the seller only opened. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.title}. ${stock.label.toLowerCase()}. Open the listing.`}
        onPress={() => router.push(`/products/${row.id}`)}
        style={({ pressed }) => (pressed ? styles.pressed : null)}
      >
        <View style={styles.head}>
          <View
            style={[styles.thumb, { backgroundColor: tintFor(row.id) }]}
            accessibilityElementsHidden
          />
          <View style={styles.headText}>
            <Text variant="smallMedium" numberOfLines={2}>
              {row.title}
            </Text>
            <Text variant="tiny" tone="faint">
              {/* The canvas prints "or GHS 64.00/wk" here. A weekly figure is the
                engine's to compute — it depends on the plan template offered on
                this product — and there is no endpoint that quotes one for a
                whole page. Printing the base price and leaving the instalment
                terms to the product screen is the honest half. */}
              {`GHS ${cedis(row.base_price_pesewas)}`}
            </Text>
          </View>
          <View style={styles.pills}>
            <Pill label={stock.label} tone={stock.tone} />
            {live ? null : <Pill label={row.status.toUpperCase()} tone="neutral" />}
          </View>
        </View>

        {row.variants.length > 0 ? (
          <>
            <Text variant="tiny" tone="faint" style={styles.summary}>
              {stock.empty === 0
                ? `${pluralise(stock.total, 'item')} across ${pluralise(row.variants.length, 'size')}`
                : `${pluralise(stock.total, 'item')} left · ${stock.empty} of ${row.variants.length} sizes out of stock`}
            </Text>
            <View style={styles.chipsRow}>
              {row.variants.map((v) => (
                <VariantChip key={v.id} variant={v} />
              ))}
            </View>
          </>
        ) : (
          <Text variant="tiny" tone="faint" style={styles.summary}>
            {/* A product with no active variant cannot be added to a basket at
              all — there is nothing to put in one — so it is invisible to a
              customer however "live" its status says it is. */}
            No sizes to sell. Customers cannot buy this until you add one.
          </Text>
        )}
      </Pressable>

      {row.variants.length > 0 ? (
        <View style={styles.actions}>
          <Button
            label={stock.empty > 0 ? `Restock ${stock.empty}` : 'Update stock'}
            variant="outline"
            compact
            onPress={() => setRestocking(true)}
          />
        </View>
      ) : null}

      <RestockSheet
        open={restocking}
        onClose={() => setRestocking(false)}
        productId={row.id}
        productTitle={row.title}
        variants={row.variants}
      />
    </Card>
  );
}

function VariantChip({ variant }: { variant: ProductVariantStock }): React.ReactElement {
  // `option_values` is whatever the seller named their options — `{size: 'L'}`,
  // `{colour: 'Indigo', size: 'L'}`, or `{}` on a product sold one way only.
  const name =
    Object.values(variant.option_values)
      .map((v) => String(v))
      .join(' · ') || variant.sku;
  const empty = variant.quantity_available === 0;
  const low = !empty && variant.quantity_available <= variant.restock_threshold;

  return (
    <View
      accessible
      accessibilityLabel={
        empty ? `${name}, out of stock` : `${name}, ${variant.quantity_available} left`
      }
      style={[styles.chip, empty ? styles.chipEmpty : low ? styles.chipLow : styles.chipOk]}
    >
      <Text style={[styles.chipName, empty && styles.chipNameEmpty]} numberOfLines={1}>
        {name}
      </Text>
      <Text style={[styles.chipCount, empty && styles.chipCountEmpty]}>
        {empty ? 'restock' : String(variant.quantity_available)}
      </Text>
    </View>
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

  pressed: { opacity: 0.75 },
  actions: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.borderSoft,
    alignItems: 'flex-start',
  },
  list: { padding: space.lg, gap: space.md },
  card: { gap: space.md },
  head: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  thumb: { width: 44, height: 44, borderRadius: radius.sm },
  headText: { flex: 1, gap: 2 },
  pills: { alignItems: 'flex-end', gap: 4 },
  summary: { lineHeight: 16 },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  chipOk: { backgroundColor: color.surfaceSunk, borderColor: 'transparent' },
  chipLow: { backgroundColor: color.warnTint, borderColor: 'transparent' },
  chipEmpty: { backgroundColor: color.accentTint, borderColor: 'transparent' },
  chipName: { fontFamily: font.medium, fontSize: 12, color: color.inkSoft },
  chipNameEmpty: { color: color.accentDark },
  chipCount: { fontFamily: font.bold, fontSize: 12, color: color.ink },
  chipCountEmpty: { color: color.accent, fontSize: 10.5, letterSpacing: 0.3 },
});
