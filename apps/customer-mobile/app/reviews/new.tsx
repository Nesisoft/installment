import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage, apiErrorStatus } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Icon,
  Loading,
  Screen,
  SectionLabel,
  StarRating,
  StickyFooter,
  Text,
  TextArea,
} from '../../src/components';
import { useCreateReview, usePendingReviews } from '../../src/features/reviews';
import { REVIEW_BODY_MAX, REVIEW_TITLE_MAX } from '../../src/features/types';
import { shortDate } from '../../src/lib/dates';
import { color, radius, space, tintFor } from '../../src/theme/tokens';

/**
 * Writing one review.
 *
 * Presented as a modal (an X, not a back chevron) because it is a single task
 * over the pending list rather than a place in the buyer's navigation — the
 * design specifies it that way and the stack registers it to match.
 *
 * The rating starts at zero. A pre-selected four is the score most people never
 * touch, and it would make the CTA's own disabled state unreachable.
 */
export default function WriteReviewScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ item?: string }>();
  const orderItemId = params.item ?? '';
  const pending = usePendingReviews();
  const create = useCreateReview();

  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const purchase = pending.data?.find((row) => row.order_item_id === orderItemId);

  if (pending.isPending) {
    return (
      <Screen>
        <ModalBar />
        <Loading />
      </Screen>
    );
  }

  if (!purchase) {
    // Reached by a stale link, or by coming back to a review already written on
    // another handset — the pending list is the only thing that hides a line
    // that has one, and `UNIQUE (order_item_id)` is what actually stops a
    // second.
    return (
      <Screen>
        <ModalBar />
        <ErrorState
          message={
            pending.error
              ? apiErrorMessage(pending.error, 'We could not load that purchase.')
              : 'That item is not waiting for a rating any more. You may already have rated it.'
          }
          onRetry={() => void pending.refetch()}
        />
      </Screen>
    );
  }

  async function submit(): Promise<void> {
    setError(null);
    try {
      await create.mutateAsync({
        order_item_id: orderItemId,
        // A strict `z.number()` on the wire — no coercion — so this must never
        // become a string on its way out.
        rating,
        // Both optional with no minimum: a rating on its own is a whole review.
        // Empty strings are dropped rather than sent, so a blank box does not
        // become a blank title on the product page.
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
      });
      router.back();
    } catch (err) {
      // 409 means the review is already there — the outcome the buyer wanted.
      // Treated as progress, the way checkout treats a duplicate charge.
      if (apiErrorStatus(err) === 409) {
        router.back();
        return;
      }
      setError(apiErrorMessage(err, 'We could not post that.'));
    }
  }

  return (
    <Screen footerHeight={96}>
      <ModalBar />

      <View style={styles.body}>
        <Card>
          <View style={styles.hero}>
            <View style={[styles.thumb, { backgroundColor: tintFor(purchase.product_id) }]} />
            <Text variant="h3" center numberOfLines={2}>
              {purchase.title}
            </Text>
            <Text variant="tiny" tone="muted" center>
              {[
                purchase.store_name,
                purchase.delivered_at ? `delivered ${shortDate(purchase.delivered_at)}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || purchase.order_number}
            </Text>
            <StarRating value={rating} onChange={setRating} />
          </View>
        </Card>

        <SectionLabel>A headline, if you like</SectionLabel>
        <TextArea
          value={title}
          onChangeText={setTitle}
          maxLength={REVIEW_TITLE_MAX}
          minHeight={52}
          placeholder="Beautiful, runs small"
          accessibilityLabel="A headline for your review"
        />

        <SectionLabel>What should the next buyer know?</SectionLabel>
        <TextArea
          value={body}
          onChangeText={setBody}
          maxLength={REVIEW_BODY_MAX}
          placeholder="The fabric and the sewing are lovely. Size up if you are between sizes."
          accessibilityLabel="Your review"
        />

        <View style={styles.note}>
          <Text variant="eyebrow" tone="faint">
            HOW THIS APPEARS
          </Text>
          <Text variant="small" tone="muted" style={styles.noteBody}>
            Publicly, under your first name and one initial — never your full name or your number.
            You can only rate something that actually reached you.
          </Text>
        </View>

        {error ? (
          <Text variant="tiny" tone="accent">
            {error}
          </Text>
        ) : null}
      </View>

      <StickyFooter>
        <Button
          label={
            create.isPending
              ? 'Posting…'
              : rating === 0
                ? 'Choose a rating first'
                : 'Post my review'
          }
          loading={create.isPending}
          disabled={rating === 0 || create.isPending}
          onPress={() => void submit()}
        />
      </StickyFooter>
    </Screen>
  );
}

/** An X rather than a chevron: this is dismissed, not navigated back from. */
function ModalBar(): React.ReactElement {
  return (
    <View style={styles.bar}>
      <Text variant="h3" style={styles.barTitle}>
        Rate this
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={10}
        onPress={() => router.back()}
      >
        <Icon name="x" size={22} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  barTitle: { flex: 1 },
  body: { paddingHorizontal: space.lg, gap: space.md },
  hero: { alignItems: 'center', gap: space.md },
  thumb: { width: 76, height: 76, borderRadius: radius.xl },
  note: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  noteBody: { lineHeight: 20 },
});
