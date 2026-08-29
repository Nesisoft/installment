import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage, useAuth } from '@installment/mobile-kit';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  Header,
  Icon,
  Loading,
  Pill,
  ScheduleStrip,
  Screen,
  SectionLabel,
  StickyFooter,
  Text,
  type IconName,
} from '../../src/components';
import {
  bestQuote,
  useDeliveryQuote,
  usePickupHubs,
  usePlanQuote,
  useProduct,
  useProductReviews,
} from '../../src/features/storefront';
import { useToggleWishlist, useWishlistIds } from '../../src/features/account';
import { useAddToCart } from '../../src/features/shop';
import { cadence, compact, ghs, initials, pluralise } from '../../src/lib/format';
import { arrivalWindow, longDate } from '../../src/lib/dates';
import { DEFAULT_CITY, DEFAULT_REGION } from '../../src/lib/config';
import { color, fillParent, radius, space, tintFor } from '../../src/theme/tokens';
import type {
  PlanQuote,
  ProductVariant,
  StorefrontProductDetails,
  StorefrontReview,
} from '../../src/features/types';

/** Room the sticky footer needs: a 54pt control plus the bar's own padding. */
const FOOTER_HEIGHT = 86;

/** Slightly taller than square — the design's gallery, and it flatters portrait shots. */
const GALLERY_ASPECT = 1.05;

export default function ProductScreen(): React.ReactElement {
  const params = useLocalSearchParams();
  const id = firstParam(params.id) ?? '';

  const { signedIn } = useAuth();
  const product = useProduct(id);
  const reviews = useProductReviews(id);
  const wishlist = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();
  const delivery = useDeliveryQuote({ city: DEFAULT_CITY, region: DEFAULT_REGION });
  const hubs = usePickupHubs();

  // Two mutations over the same endpoint rather than one shared between the two
  // buttons: they must not light each other's spinner, and "Added to your cart"
  // must not appear under a Buy now that is already on its way to checkout.
  const addToCart = useAddToCart();
  const buyNow = useAddToCart();

  const [variantId, setVariantId] = useState<string | null>(null);
  const [planTemplateId, setPlanTemplateId] = useState<string | null>(null);

  const detail = product.data;

  // An inactive variant is not on sale at all, so it is never offered and never
  // becomes the default the price is read from.
  const variants = (detail?.variants ?? []).filter((v) => v.is_active);
  const fallbackVariant = variants.find((v) => v.quantity_available > 0) ?? variants[0] ?? null;
  const variant = variants.find((v) => v.id === variantId) ?? fallbackVariant;
  const price = variant?.effective_price_pesewas ?? detail?.base_price_pesewas ?? 0;

  // Quote only against the templates the merchant opted this product into: with
  // no ids the endpoint quotes every template in the catalogue, which would
  // offer instalments on something that cannot be financed.
  const quotes = usePlanQuote(detail?.installment_eligible ? price : 0, detail?.plan_template_ids);
  const options = (quotes.data ?? []).filter((q) => q.eligible);
  // A variant change re-quotes at a new amount, and the plan the customer picked
  // may not survive it — so the best offer is the fallback, never an error.
  const quote =
    options.find((q) => q.plan_template_id === planTemplateId) ?? bestQuote(quotes.data);

  if (product.isPending) {
    return (
      <Screen>
        <Header back />
        <Loading />
      </Screen>
    );
  }

  if (product.isError || !detail) {
    return (
      <Screen>
        <Header back />
        <ErrorState
          message={apiErrorMessage(product.error, "We couldn't load this item just now.")}
          onRetry={() => void product.refetch()}
        />
      </Screen>
    );
  }

  const saved = (wishlist.data ?? []).includes(detail.id);
  const purchasable = detail.in_stock && (variant?.quantity_available ?? 0) > 0;
  const rating = detail.rating_count > 0 ? detail.rating_avg : null;
  // The saved compare-at and its percentage were struck against the base price.
  // A variant that overrides the price would make both of them a lie, so they
  // stand down rather than discount the wrong number.
  const compareAt = price === detail.base_price_pesewas ? detail.compare_at_price_pesewas : null;
  const reviewRows = (reviews.data?.rows ?? []).slice(0, 3);
  const cta = ctaCopy(quote, purchasable);

  /** Browsing is open; the cart and the wishlist are the customer's own data. */
  const needsAccount = (): boolean => {
    if (signedIn) return false;
    router.push('/onboarding');
    return true;
  };

  const onToggleSave = (): void => {
    if (needsAccount()) return;
    toggleSave.mutate({ productId: detail.id, saved });
  };

  const onShare = (): void => {
    // Dismissing the sheet mid-animation rejects; there is nothing to tell the
    // customer when a share they abandoned does not complete.
    void Share.share({
      title: detail.title,
      message: `${detail.title} — ${ghs(price)} on Ejua`,
    }).catch(() => undefined);
  };

  const onAddToCart = (): void => {
    if (needsAccount() || !variant) return;
    addToCart.mutate({ variant_id: variant.id });
  };

  const onBuyNow = (): void => {
    if (needsAccount() || !variant) return;
    // Checkout works off the cart, so the push waits for the line to land —
    // opening it first would show a cart without this item in it.
    buyNow.mutate({ variant_id: variant.id }, { onSuccess: () => router.push('/checkout') });
  };

  return (
    <View style={styles.flex}>
      <Screen
        footerHeight={FOOTER_HEIGHT}
        refreshing={product.isRefetching}
        onRefresh={() => void product.refetch()}
      >
        <Gallery product={detail} saved={saved} onToggleSave={onToggleSave} onShare={onShare} />

        <View style={styles.body}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Visit ${detail.store.display_name}`}
            onPress={() => router.push(`/store/${detail.store_slug}`)}
            style={({ pressed }) => [styles.vendorRow, { opacity: pressed ? 0.75 : 1 }]}
          >
            <View style={styles.vendorTile}>
              {detail.store.logo_url ? (
                <Image
                  source={{ uri: detail.store.logo_url }}
                  style={fillParent}
                  contentFit="cover"
                  transition={140}
                  accessibilityLabel={`${detail.store.display_name} logo`}
                />
              ) : (
                <Text variant="smallMedium" tone="soft">
                  {initials(detail.store.display_name)}
                </Text>
              )}
            </View>
            <View style={styles.vendorName}>
              <Text variant="bodyMedium" numberOfLines={1}>
                {detail.store.display_name}
              </Text>
            </View>
            {detail.store.verified ? <Pill label="VERIFIED" tone="success" /> : null}
            <Text variant="smallMedium" tone="accent">
              Visit shop ›
            </Text>
          </Pressable>

          <View style={styles.headline}>
            <Text variant="h2">{detail.title}</Text>

            <View style={styles.ratingRow}>
              {rating !== null ? (
                <>
                  <Stars rating={rating} />
                  <Text variant="smallMedium">{rating.toFixed(1)}</Text>
                  <Text variant="small" tone="muted">
                    {pluralise(detail.rating_count, 'review')}
                  </Text>
                </>
              ) : (
                // Nothing is invented for an unrated product: no stars, no 0.0.
                <Pill label="NEW" />
              )}
              {detail.sold_count > 0 ? (
                <Text variant="small" tone="muted">
                  {compact(detail.sold_count)} sold
                </Text>
              ) : null}
            </View>

            <View style={styles.priceRow}>
              <Text variant="h1">{ghs(price)}</Text>
              {compareAt !== null ? (
                <Text variant="small" tone="faint" style={styles.strike}>
                  {ghs(compareAt)}
                </Text>
              ) : null}
              {compareAt !== null && detail.discount_percent ? (
                <Pill label={`-${detail.discount_percent}%`} tone="accent" />
              ) : null}
            </View>
          </View>

          {variants.length > 1 ? (
            <View>
              {detail.variant_label ? <SectionLabel>{detail.variant_label}</SectionLabel> : null}
              <View style={styles.chipWrap}>
                {variants.map((v) => {
                  const soldOut = v.quantity_available === 0;
                  return (
                    // `Chip` has no disabled state, so a sold-out option is dimmed
                    // and left without a handler; its label carries the reason.
                    <View key={v.id} style={soldOut ? styles.chipSoldOut : null}>
                      <Chip
                        label={soldOut ? `${variantValue(v)} · Sold out` : variantValue(v)}
                        selected={v.id === variant?.id}
                        onPress={
                          soldOut
                            ? undefined
                            : () => {
                                setVariantId(v.id);
                                // The confirmation below belongs to the line just
                                // added, which was for the option being replaced.
                                addToCart.reset();
                              }
                        }
                      />
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          {detail.installment_eligible ? (
            <InstalmentPanel
              quote={quote}
              options={options}
              pending={quotes.isPending}
              failed={quotes.isError}
              reason={quotes.data?.[0]?.ineligible_reason ?? null}
              onRetry={() => void quotes.refetch()}
              onSelect={setPlanTemplateId}
            />
          ) : null}

          <Card bare>
            <View style={styles.assuranceRow}>
              <Icon name="truck" size={19} color={color.inkSoft} />
              <View style={styles.assuranceText}>
                {delivery.data ? (
                  <>
                    <Text variant="bodyMedium">
                      Delivery to {DEFAULT_CITY} ·{' '}
                      {delivery.data.fee_pesewas === 0 ? 'Free' : ghs(delivery.data.fee_pesewas)}
                    </Text>
                    <Text variant="small" tone="muted">
                      {arrivalWindow(delivery.data.eta_earliest, delivery.data.eta_latest)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text variant="bodyMedium">Delivery to {DEFAULT_CITY}</Text>
                    <Text variant="small" tone="muted">
                      {delivery.isPending
                        ? 'Working out the fee…'
                        : 'The fee is confirmed at checkout.'}
                    </Text>
                  </>
                )}
                {hubs.data && hubs.data.length > 0 ? (
                  <Text variant="small" tone="muted">
                    Or collect free from {pluralise(hubs.data.length, 'pickup point')} in{' '}
                    {DEFAULT_CITY}.
                  </Text>
                ) : null}
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.assuranceRow}>
              <Icon name="shield" size={19} color={color.inkSoft} />
              <View style={styles.assuranceText}>
                <Text variant="bodyMedium">Escrow protected</Text>
                {/* The window is set per order, so no number is promised here. */}
                <Text variant="small" tone="muted">
                  The vendor is paid only after your return window closes.
                </Text>
              </View>
            </View>
          </Card>

          {detail.description ? (
            <View>
              <SectionLabel>About this item</SectionLabel>
              <Text variant="body" tone="soft">
                {detail.description}
              </Text>
            </View>
          ) : null}

          {reviewRows.length > 0 ? (
            <View>
              <SectionLabel>Reviews</SectionLabel>
              <View style={styles.reviewList}>
                {reviewRows.map((review) => (
                  <ReviewRow key={review.id} review={review} />
                ))}
              </View>
              {reviews.data && reviews.data.total > reviewRows.length ? (
                <Text variant="small" tone="faint" style={styles.reviewMore}>
                  Showing {reviewRows.length} of {pluralise(reviews.data.total, 'review')}.
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Screen>

      <StickyFooter>
        {!purchasable ? (
          <Text variant="small" tone="muted" style={styles.footerNote}>
            {variants.length === 0
              ? "This item isn't available to buy right now."
              : 'This option is out of stock right now.'}
          </Text>
        ) : null}

        {addToCart.isError ? (
          <Text variant="small" tone="accent" style={styles.footerNote}>
            {apiErrorMessage(addToCart.error, "We couldn't add that to your cart.")}
          </Text>
        ) : null}

        {addToCart.isSuccess ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Added to your cart. View your cart."
            onPress={() => router.push('/cart')}
            style={styles.addedRow}
          >
            <Icon name="check" size={14} color={color.success} />
            <Text variant="small" tone="success" style={styles.addedText}>
              Added to your cart
            </Text>
            <Text variant="smallMedium" tone="accent">
              View cart ›
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.footerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add ${detail.title} to your cart`}
            accessibilityState={{ disabled: !purchasable, busy: addToCart.isPending }}
            onPress={purchasable && !addToCart.isPending ? onAddToCart : undefined}
            style={({ pressed }) => [
              styles.cartButton,
              { opacity: !purchasable ? 0.55 : pressed ? 0.85 : 1 },
            ]}
          >
            {addToCart.isPending ? (
              <ActivityIndicator color={color.ink} />
            ) : (
              <Icon name="bag" size={20} color={color.ink} />
            )}
          </Pressable>

          <Button
            label={cta.label}
            sublabel={cta.sublabel}
            variant="primary"
            disabled={!purchasable}
            loading={buyNow.isPending}
            onPress={onBuyNow}
            style={styles.cta}
          />
        </View>
      </StickyFooter>
    </View>
  );
}

/**
 * The image pager.
 *
 * A product with no photography falls back to its stable tint rather than a grey
 * box, the same way the catalogue tiles do — a blank panel reads as a failed
 * load, a tinted one as a shop that has not shot this item yet.
 */
function Gallery({
  product,
  saved,
  onToggleSave,
  onShare,
}: {
  product: StorefrontProductDetails;
  saved: boolean;
  onToggleSave: () => void;
  onShare: () => void;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);

  // `flatMap` rather than `filter` so the narrowed `url` survives into the map.
  const images = product.images.flatMap((img) => (img.url ? [{ ...img, url: img.url }] : []));
  const height = Math.round(width * GALLERY_ASPECT);

  return (
    <View style={[styles.gallery, { height, backgroundColor: tintFor(product.id) }]}>
      {images.length > 0 ? (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
            setPage(Math.round(e.nativeEvent.contentOffset.x / width))
          }
        >
          {images.map((img) => (
            <Image
              key={img.id}
              source={{ uri: img.url }}
              style={{ width, height }}
              contentFit="cover"
              transition={160}
              accessibilityLabel={img.alt_text ?? product.title}
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.galleryControls, { top: insets.top + space.sm }]}>
        <RoundButton
          icon="chevron-left"
          label="Go back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        <View style={styles.galleryActions}>
          <RoundButton
            icon={saved ? 'heart-filled' : 'heart'}
            tint={saved ? color.accent : color.ink}
            label={saved ? 'Remove from saved items' : 'Save this item'}
            onPress={onToggleSave}
          />
          <RoundButton icon="share" label={`Share ${product.title}`} onPress={onShare} />
        </View>
      </View>

      {images.length > 1 ? (
        <View style={styles.dots}>
          {images.map((img, index) => (
            <View key={img.id} style={[styles.dot, index === page ? styles.dotOn : null]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  tint = color.ink,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.roundButton, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} size={18} color={tint} />
    </Pressable>
  );
}

/**
 * What paying in instalments would look like for this exact amount.
 *
 * Every figure here is the engine's — the schedule, the deposit, the grace
 * period and the late-fee rate all come back with the quote, so what the
 * customer reads on the shelf is the contract they would sign at checkout.
 */
function InstalmentPanel({
  quote,
  options,
  pending,
  failed,
  reason,
  onRetry,
  onSelect,
}: {
  quote: PlanQuote | null;
  options: PlanQuote[];
  pending: boolean;
  failed: boolean;
  reason: string | null;
  onRetry: () => void;
  onSelect: (planTemplateId: string) => void;
}): React.ReactElement | null {
  if (quote) {
    return (
      <Card style={styles.planCard}>
        <View style={styles.planHead}>
          <Text variant="h3">Pay in {quote.installments.length} with Ejua</Text>
          {/* Only when the engine says the rate really is nil. */}
          {quote.interest_rate_bps === 0 ? <Pill label="0% INTEREST" tone="success" /> : null}
        </View>

        {options.length > 1 ? (
          <View style={styles.chipWrap}>
            {options.map((option) => (
              <Chip
                key={option.plan_template_id}
                label={`${option.name} · ${pluralise(option.installments.length, 'payment')}`}
                selected={option.plan_template_id === quote.plan_template_id}
                onPress={() => onSelect(option.plan_template_id)}
              />
            ))}
          </View>
        ) : null}

        {/* The strip bleeds to the card's edges so the last cell can be scrolled
            fully into view instead of stopping short at the card padding. */}
        <View style={styles.planStrip}>
          <ScheduleStrip installments={quote.installments} />
        </View>

        <Text variant="small" tone="muted">
          {planTerms(quote)}
        </Text>
        <Text variant="small" tone="soft">
          Approved in seconds — you&apos;ll see the decision before you pay.
        </Text>
      </Card>
    );
  }

  if (pending) {
    return (
      <Text variant="small" tone="muted">
        Checking your instalment options…
      </Text>
    );
  }

  if (failed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try loading instalment options again"
        onPress={onRetry}
      >
        <Text variant="small" tone="muted">
          We couldn&apos;t load instalment options.{' '}
          <Text variant="smallMedium" tone="accent">
            Try again
          </Text>
        </Text>
      </Pressable>
    );
  }

  // Not eligible: the engine's own words, said once and quietly. There is
  // nothing the customer can do about a plan minimum from the shelf.
  if (!reason) return null;
  return (
    <Text variant="small" tone="muted">
      {reason}
    </Text>
  );
}

function ReviewRow({ review }: { review: StorefrontReview }): React.ReactElement {
  return (
    <View style={styles.review}>
      <View style={styles.reviewHead}>
        <Stars rating={review.rating} size={12} />
        <Text variant="smallMedium" numberOfLines={1} style={styles.reviewAuthor}>
          {review.author}
        </Text>
        <Text variant="tiny" tone="faint">
          {longDate(review.created_at)}
        </Text>
      </View>
      {review.title ? <Text variant="smallMedium">{review.title}</Text> : null}
      {review.body ? (
        <Text variant="small" tone="soft">
          {review.body}
        </Text>
      ) : null}
    </View>
  );
}

const STAR_POSITIONS = [1, 2, 3, 4, 5];

function Stars({ rating, size = 13 }: { rating: number; size?: number }): React.ReactElement {
  // Rounded to whole stars: the row is read at a glance and the exact average
  // is printed beside it, so half-star glyphs would add precision, not meaning.
  const filled = Math.round(rating);
  return (
    <View style={styles.stars}>
      {STAR_POSITIONS.map((position) => (
        <Icon
          key={position}
          name={position <= filled ? 'star-filled' : 'star'}
          size={size}
          color={position <= filled ? color.ink : color.mutedSoft}
        />
      ))}
    </View>
  );
}

/** The primary action's two lines, from the quote the customer is looking at. */
function ctaCopy(
  quote: PlanQuote | null,
  purchasable: boolean,
): { label: string; sublabel?: string } {
  if (!purchasable) return { label: 'Out of stock' };
  // This button navigates to checkout, so it must never read "Add to cart" —
  // the icon button beside it is the one that adds. Reached when a product
  // offers no instalment plan, or while the quote is still loading.
  if (!quote) return { label: 'Buy now' };

  const per = ghs(quote.per_installment_pesewas);
  const every = cadence(quote.installment_frequency_days);

  if (quote.down_payment_pesewas === 0) {
    return {
      label: `Pay in ${quote.installments.length} instalments`,
      sublabel: `${quote.installments.length} × ${per} ${every}`,
    };
  }
  // `number_of_installments` excludes the deposit — which is exactly what "then
  // N × …" means, now that the deposit has been named on the line above it.
  return {
    label: `Pay ${ghs(quote.down_payment_pesewas)} today`,
    sublabel: `then ${quote.number_of_installments} × ${per} ${every}`,
  };
}

/** Grace and late fees in the customer's words, from the quote's own fields. */
function planTerms(quote: PlanQuote): string {
  const grace =
    quote.grace_period_days > 0
      ? `You get ${pluralise(quote.grace_period_days, 'day')} of grace after each due date.`
      : 'Each payment is due on the date shown.';

  const late =
    quote.late_fee_bps_per_week === 0
      ? 'There is no late fee on this plan.'
      : `After that, a late fee of ${percent(quote.late_fee_bps_per_week)} a week applies, capped at ${percent(quote.late_fee_cap_bps)}.`;

  return `${grace} ${late}`;
}

/** Basis points as a percentage: 200 → "2%", 250 → "2.5%". */
function percent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/**
 * The label a variant chip carries.
 *
 * `option_values` is an untyped bag on the wire; only a scalar makes a chip, and
 * the SKU is the honest fallback for anything else.
 */
function variantValue(variant: ProductVariant): string {
  const first = Object.values(variant.option_values)[0];
  return typeof first === 'string' || typeof first === 'number' ? String(first) : variant.sku;
}

/** A repeated route param arrives as an array; the first value wins. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gallery: { width: '100%' },
  galleryControls: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  galleryActions: { flexDirection: 'row', gap: space.sm },
  roundButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    position: 'absolute',
    bottom: space.md,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  dotOn: { backgroundColor: color.onDark, width: 16 },

  body: { padding: space.lg, gap: space.xl },
  vendorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  vendorTile: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  vendorName: { flex: 1 },

  headline: { gap: space.sm },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stars: { flexDirection: 'row', gap: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  strike: { textDecorationLine: 'line-through' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chipSoldOut: { opacity: 0.45 },

  planCard: { gap: space.md },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  planStrip: { marginHorizontal: -space.lg, paddingLeft: space.lg },

  assuranceRow: { flexDirection: 'row', gap: space.md, padding: space.lg },
  assuranceText: { flex: 1, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderSoft },

  reviewList: { gap: space.lg },
  review: { gap: 4 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  reviewAuthor: { flexShrink: 1 },
  reviewMore: { marginTop: space.md },

  footerNote: { marginBottom: space.sm },
  addedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.sm },
  addedText: { flex: 1 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cartButton: {
    width: 54,
    height: 54,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cta: { flex: 1 },
});
