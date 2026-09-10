import React from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage, useAuth } from '@installment/mobile-kit';
import {
  Button,
  EmptyState,
  ErrorState,
  GRID_WIDTH,
  Header,
  Icon,
  Loading,
  QuotedProductCard,
  Screen,
  Text,
} from '../src/components';
import { useToggleWishlist, useWishlist, useWishlistIds } from '../src/features/account';
import { pluralise } from '../src/lib/format';
import { color, space } from '../src/theme/tokens';

/**
 * Everything the shopper has saved.
 *
 * `useWishlist` has existed with zero callers since it was written, and both
 * controls labelled "Saved" — the account menu row and the stat tile — opened
 * Browse instead. `GET /me/wishlist` had no consumer anywhere in the monorepo.
 *
 * Reusing `QuotedProductCard` rather than rebuilding the artboard's tile, and
 * the difference is deliberate. The shipped card uppercases the shop name,
 * draws SOLD OUT as a dark pill and toggles the heart between filled and
 * outline; the artboard draws a lowercase shop name, a light pill on a
 * translucent scrim and a heart that is always filled. A saved-items grid that
 * looked different from every other grid in the app would be the drawing
 * winning over the product.
 */
export default function SavedScreen(): React.ReactElement {
  const { signedIn } = useAuth();
  const saved = useWishlist(signedIn);
  const savedIds = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();

  const rows = saved.data ?? [];
  const ids = new Set(savedIds.data ?? []);

  return (
    <Screen refreshing={saved.isRefetching} onRefresh={() => void saved.refetch()}>
      <Header
        title="Saved"
        subtitle={rows.length > 0 ? pluralise(rows.length, 'item') : undefined}
        back
      />

      <View style={styles.body}>
        {saved.isPending ? (
          <Loading />
        ) : saved.error ? (
          <ErrorState
            message={apiErrorMessage(saved.error, 'We could not load your saved items.')}
            onRetry={() => void saved.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Icon name="heart" size={26} color={color.mutedSoft} />}
            title="Nothing saved yet"
            body="Tap the heart on anything you are thinking about. It waits here until you decide."
            action={
              <Button
                label="Browse the marketplace"
                variant="dark"
                onPress={() => router.push('/browse')}
              />
            }
          />
        ) : (
          <>
            <View style={styles.grid}>
              {rows.map((product) => (
                <QuotedProductCard
                  key={product.id}
                  product={product}
                  width={GRID_WIDTH}
                  saved={ids.has(product.id)}
                  onToggleSave={() =>
                    toggleSave.mutate({ productId: product.id, saved: ids.has(product.id) })
                  }
                />
              ))}
            </View>

            <Text variant="tiny" tone="faint" center style={styles.footnote}>
              Saving something does not hold it. Sellers here have one or two of a size.
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.md, paddingTop: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  footnote: { marginTop: space.sm, lineHeight: 16 },
});
