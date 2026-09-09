import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Card,
  EmptyState,
  ErrorState,
  Header,
  Loading,
  Screen,
  StarRating,
  Text,
} from '../../src/components';
import { usePendingReviews } from '../../src/features/reviews';
import type { ReviewablePurchase } from '../../src/features/types';
import { shortDate } from '../../src/lib/dates';
import { pluralise } from '../../src/lib/format';
import { color, radius, space, tintFor } from '../../src/theme/tokens';

/**
 * The things this buyer received and has not rated.
 *
 * `GET /me/reviews/pending` had no caller anywhere in the monorepo while
 * `rating_avg` and `rating_count` rendered on the product screen, on every
 * product card, in the vendor header and as a "Top rated" sort — and the
 * product screen fetched the review list. Four surfaces reading a table
 * nothing could write to. Every average was null and every list empty, and
 * none of it looked broken.
 */
export default function PendingReviewsScreen(): React.ReactElement {
  const pending = usePendingReviews();
  const rows = pending.data ?? [];

  return (
    <Screen refreshing={pending.isRefetching} onRefresh={() => void pending.refetch()}>
      <Header
        title="Rate what you bought"
        subtitle={
          rows.length > 0 ? `${rows.length} ${pluralise(rows.length, 'thing')} to rate` : undefined
        }
        back
      />

      <View style={styles.body}>
        {pending.isPending ? (
          <Loading />
        ) : pending.error ? (
          <ErrorState
            message={apiErrorMessage(pending.error, 'We could not load these.')}
            onRetry={() => void pending.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing to rate"
            body="Once something you ordered reaches you, it appears here and you can say what you thought of it."
          />
        ) : (
          <>
            <View style={styles.why}>
              <Text variant="eyebrow" tone="accent">
                WHY IT MATTERS HERE
              </Text>
              <Text variant="small" tone="muted" style={styles.whyBody}>
                Ejua sellers are market traders, not brands. A rating is most of what a buyer in
                another city has to go on.
              </Text>
            </View>

            {rows.map((row) => (
              <PendingCard key={row.order_item_id} row={row} />
            ))}

            <Text variant="tiny" tone="faint" center style={styles.footer}>
              Only things that reached you appear here.
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}

function PendingCard({ row }: { row: ReviewablePurchase }): React.ReactElement {
  const open = (): void => router.push(`/reviews/new?item=${row.order_item_id}`);

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rate ${row.title}`}
        onPress={open}
        style={styles.media}
      >
        <View style={[styles.thumb, { backgroundColor: tintFor(row.product_id) }]} />
        <View style={styles.mediaText}>
          <Text variant="bodyMedium" numberOfLines={2}>
            {row.title}
          </Text>
          <Text variant="tiny" tone="muted">
            {/* Both joined onto the projection this slice. Without them the card
                is a bare product name weeks after the fact. */}
            {[row.store_name, row.delivered_at ? shortDate(row.delivered_at) : null]
              .filter(Boolean)
              .join(' · ') || row.order_number}
          </Text>
        </View>
      </Pressable>

      <View style={styles.rate}>
        {/* Read-only here: tapping any star would submit a rating with no
            chance to change it. The row opens the form instead. */}
        <StarRating value={0} size={24} showWord={false} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Rate ${row.title}`}
          onPress={open}
        >
          <Text variant="smallMedium" tone="accent">
            Rate
          </Text>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.md, paddingTop: space.md },
  why: {
    backgroundColor: color.accentTintSoft,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  whyBody: { lineHeight: 20 },
  media: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  thumb: { width: 52, height: 52, borderRadius: radius.sm },
  mediaText: { flex: 1, gap: 2 },
  rate: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: color.borderSoft,
    marginTop: space.md,
    paddingTop: space.md,
  },
  footer: { marginTop: space.sm },
});
