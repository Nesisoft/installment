import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { apiErrorStatus, useAuth } from '@installment/mobile-kit';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Loading,
  Pill,
  QuotedProductCard,
  Screen,
  Text,
} from '../../src/components';
import { useBrowse, useStore, type BrowseFilters } from '../../src/features/storefront';
import { useToggleWishlist, useWishlistIds } from '../../src/features/account';
import { compact, initials, pluralise } from '../../src/lib/format';
import { longDate, parseApiDate } from '../../src/lib/dates';
import { color, fillParent, radius, space, tintFor } from '../../src/theme/tokens';
import type { StorefrontStore } from '../../src/features/types';

/**
 * A vendor's shelf: who they are, what their record is, and everything they sell.
 *
 * The profile and the shelf are two requests because they are two different
 * reads — `GET /storefront/stores/:slug` knows the store by slug, the catalogue
 * knows it by id — so the shelf cannot be asked for until the profile answers.
 */
export default function StoreScreen(): React.ReactElement {
  const params = useLocalSearchParams();
  const slug = firstParam(params.slug) ?? '';
  const store = useStore(slug);
  const qc = useQueryClient();

  // `useStore` is disabled without a slug, and a disabled query stays `pending`
  // forever — so an unroutable link has to be caught here rather than left to
  // spin behind a loading indicator.
  const noSlug = slug.length === 0;
  const gone = apiErrorStatus(store.error) === 404;

  const refresh = (): void => {
    void store.refetch();
    // The shelf lives in a child that only mounts once the store id is known,
    // so the pull refetches it by query key rather than through a hook this
    // component is not in a position to hold.
    const id = store.data?.id;
    if (id) void qc.refetchQueries({ queryKey: ['browse', shelfFilters(id)] });
  };

  return (
    <Screen refreshing={store.isRefetching} onRefresh={refresh}>
      <Banner store={store.data} />

      {store.isPending && !noSlug ? <Loading /> : null}

      {noSlug || gone ? (
        <EmptyState
          icon={<Icon name="store" size={26} color={color.mutedSoft} />}
          title="This store isn't here"
          body="The link may be old, or the vendor may have closed their shop on Ejua."
          action={
            <Button
              label="Browse the marketplace"
              variant="ghost"
              onPress={() => router.replace('/browse')}
            />
          }
        />
      ) : null}

      {store.isError && !gone ? (
        <ErrorState
          message="We couldn't load this store just now."
          onRetry={() => void store.refetch()}
        />
      ) : null}

      {store.data ? (
        <View style={styles.body}>
          {store.data.about ? (
            <View style={styles.section}>
              <Text variant="h3" style={styles.sectionPad}>
                About
              </Text>
              <Text variant="body" tone="soft" style={styles.sectionPad}>
                {store.data.about}
              </Text>
            </View>
          ) : null}

          <Shelf storeId={store.data.id} storeName={store.data.display_name} />
        </View>
      ) : null}
    </Screen>
  );
}

/** The dark chrome: banner art, identity, and the store's record. */
function Banner({ store }: { store: StorefrontStore | undefined }): React.ReactElement {
  const insets = useSafeAreaInsets();
  const meta = store ? metaLine(store) : '';

  return (
    <View style={[styles.banner, { paddingTop: insets.top + space.sm }]}>
      {store?.banner_url ? (
        <>
          <Image
            source={{ uri: store.banner_url }}
            style={fillParent}
            contentFit="cover"
            transition={200}
          />
          {/* Vendor banners are uncurated photography, so the chrome cannot
              assume a dark image. The scrim is what keeps the name and the
              stats legible over whatever was uploaded. */}
          <View style={styles.scrim} />
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={12}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={styles.back}
      >
        <Icon name="chevron-left" size={22} color={color.onDark} />
      </Pressable>

      {store ? (
        <>
          <View style={styles.identity}>
            <View
              style={[styles.tile, { backgroundColor: tintFor(store.id) }]}
              // The tile only repeats the name sitting beside it; announcing
              // "AB" before "Ama Boateng Electronics" is noise.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {store.logo_url ? (
                <Image
                  source={{ uri: store.logo_url }}
                  style={fillParent}
                  contentFit="cover"
                  transition={160}
                />
              ) : (
                <Text variant="h2">{initials(store.display_name)}</Text>
              )}
            </View>

            <View style={styles.identityText}>
              <View style={styles.nameRow}>
                <Text variant="h2" tone="onDark" numberOfLines={2} style={styles.name}>
                  {store.display_name}
                </Text>
                {store.verified ? <Pill label="VERIFIED" tone="onDark" /> : null}
              </View>
              {meta ? (
                <Text variant="small" tone="onDarkMuted">
                  {meta}
                </Text>
              ) : null}
            </View>
          </View>

          <Stats store={store} />
        </>
      ) : null}
    </View>
  );
}

/**
 * Rating, orders and on-time delivery.
 *
 * Every one of these can be genuinely unknown for a young store, and each says
 * so in its own way: a store with no ratings is "New", a missing on-time figure
 * is an em dash. Printing "0.0" or "0%" for an absent measurement would read as
 * a bad record rather than as no record, which is a lie the vendor pays for.
 */
function Stats({ store }: { store: StorefrontStore }): React.ReactElement {
  const rating =
    store.rating_avg === null
      ? store.rating_count === 0
        ? 'New'
        : '—'
      : store.rating_avg.toFixed(1);

  const ratingSpoken =
    store.rating_avg === null
      ? store.rating_count === 0
        ? 'no ratings yet'
        : 'not available'
      : `${store.rating_avg.toFixed(1)} out of 5, from ${pluralise(store.rating_count, 'rating')}`;

  return (
    <View style={styles.stats}>
      <Stat label="Rating" value={rating} spoken={`Rating: ${ratingSpoken}`} />
      <View style={styles.statLine} />
      <Stat
        label="Orders"
        value={compact(store.order_count)}
        // The tile shows "6.4k"; the reader gets the whole number.
        spoken={`Orders: ${pluralise(store.order_count, 'order')}`}
      />
      <View style={styles.statLine} />
      <Stat
        label="On time"
        // The projection can hand back a fraction of a percent. A whole number
        // is what the design shows and what anyone reads off a stat tile.
        value={store.on_time_percent === null ? '—' : `${Math.round(store.on_time_percent)}%`}
        spoken={
          store.on_time_percent === null
            ? 'On time: not available'
            : `On time: ${Math.round(store.on_time_percent)} percent`
        }
      />
    </View>
  );
}

function Stat({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}): React.ReactElement {
  return (
    <View style={styles.stat} accessible accessibilityLabel={spoken}>
      <Text variant="h3" tone="onDark">
        {value}
      </Text>
      <Text variant="eyebrow" tone="onDarkFaint">
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/** Everything the store has listed, as the same tile the rest of the app uses. */
function Shelf({ storeId, storeName }: { storeId: string; storeName: string }): React.ReactElement {
  const { signedIn } = useAuth();
  const browse = useBrowse(shelfFilters(storeId));
  const wishlist = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();

  const rows = browse.data?.rows ?? [];
  const total = browse.data?.total ?? null;
  const saved = new Set(wishlist.data ?? []);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="h3">All products</Text>
        {total !== null ? (
          <Text variant="small" tone="muted">
            {pluralise(total, 'item')}
          </Text>
        ) : null}
      </View>

      {browse.isPending ? <Loading /> : null}

      {browse.isError ? (
        <ErrorState
          message="We couldn't load this store's items just now."
          onRetry={() => void browse.refetch()}
        />
      ) : null}

      {browse.data && rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="box" size={26} color={color.mutedSoft} />}
          title="Nothing on this shelf yet"
          body={`${storeName} has no items listed right now. Check back soon.`}
          action={
            <Button
              label="Browse the marketplace"
              variant="ghost"
              onPress={() => router.push('/browse')}
            />
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <View style={styles.grid}>
          {rows.map((p) => (
            <QuotedProductCard
              key={p.id}
              product={p}
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

      {/* The catalogue read is a single limited page — there is no paging hook
          in the app yet — so a shelf longer than the limit says what it is
          showing instead of letting the grid imply it is the whole shop. */}
      {total !== null && rows.length < total ? (
        <Text variant="tiny" tone="faint" style={styles.sectionPad}>
          Showing the first {rows.length} of {pluralise(total, 'item')}.
        </Text>
      ) : null}
    </View>
  );
}

/** "Kumasi · Joined 14 Mar 2025" — either half stands on its own. */
function metaLine(store: StorefrontStore): string {
  // `longDate` renders an em dash for anything it cannot parse, and "Joined —"
  // is worse than saying nothing at all about when the store opened.
  const joined = parseApiDate(store.joined_at) ? `Joined ${longDate(store.joined_at)}` : null;
  return [store.city, joined].filter(Boolean).join(' · ');
}

/**
 * The shelf's query, in one place so the pull-to-refresh can name the same key
 * the child registers. A store page asks for more than the browse grid's
 * default page: this is the whole of one vendor's shop, not a filtered slice.
 */
const SHELF_LIMIT = 48;

function shelfFilters(storeId: string): BrowseFilters {
  return { store_id: storeId, limit: SHELF_LIMIT };
}

/** A repeated query key arrives as an array; the first value wins. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Two columns with a gutter, measured rather than flexed.
 *
 * `flex: 1` inside a wrapping row does not produce a grid — the last row of an
 * odd-length list stretches its single card to full width. An explicit width
 * keeps every tile the same size whatever the count.
 */

const styles = StyleSheet.create({
  banner: {
    backgroundColor: color.dark,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.lg,
  },
  scrim: { ...fillParent, backgroundColor: color.scrim },
  back: { alignSelf: 'flex-start', padding: 2 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tile: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  identityText: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flexShrink: 1 },
  stats: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    paddingVertical: space.md,
  },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statLine: { width: 1, backgroundColor: color.darkLine },
  body: { gap: space.xxl, paddingTop: space.xl },
  section: { gap: space.md },
  sectionPad: { paddingHorizontal: space.lg },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
});
