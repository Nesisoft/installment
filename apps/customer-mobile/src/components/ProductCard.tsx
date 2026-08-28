import React from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Text } from './Text';
import { Pill } from './Pill';
import { Icon } from './Icon';
import { color, fillParent, radius, space, tintFor } from '../theme/tokens';
import { ghs } from '../lib/format';
import type { StorefrontProduct } from '../features/types';

export interface ProductCardProps {
  product: StorefrontProduct;
  /** "or GHS 583/week", quoted by the engine. Omitted when no plan fits. */
  weekly?: string | null;
  width?: number;
  saved?: boolean;
  onToggleSave?: () => void;
  style?: StyleProp<ViewStyle>;
  /** Compact form for the flash-deal carousel. */
  compact?: boolean;
}

/**
 * The product tile used by the home rails, the browse grid, search results and
 * a store's shelf — one component so those four never drift apart.
 *
 * A product with no image gets a stable tint derived from its id rather than a
 * grey box: the catalogue has no art direction yet, and a shop full of grey
 * rectangles reads as broken rather than as unfinished.
 */
export function ProductCard({
  product,
  weekly,
  width,
  saved,
  onToggleSave,
  style,
  compact,
}: ProductCardProps): React.ReactElement {
  const tint = tintFor(product.id);
  const imageHeight = compact ? 108 : 132;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${product.title}, ${ghs(product.base_price_pesewas)}`}
      onPress={() => router.push(`/product/${product.id}`)}
      style={({ pressed }) => [
        styles.card,
        width ? { width } : styles.flex,
        { opacity: pressed ? 0.85 : 1 },
        style,
      ]}
    >
      <View style={[styles.imageWrap, { height: imageHeight, backgroundColor: tint }]}>
        {product.primary_image_url ? (
          <Image
            source={{ uri: product.primary_image_url }}
            style={fillParent}
            contentFit="cover"
            transition={160}
            accessibilityLabel={product.primary_image_alt ?? product.title}
          />
        ) : null}

        {product.discount_percent ? (
          <Pill label={`-${product.discount_percent}%`} tone="dark" style={styles.discount} />
        ) : null}

        {onToggleSave ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Remove from saved items' : 'Save this item'}
            hitSlop={10}
            onPress={onToggleSave}
            style={styles.heart}
          >
            <Icon
              name={saved ? 'heart-filled' : 'heart'}
              size={15}
              color={saved ? color.accent : color.inkSoft}
            />
          </Pressable>
        ) : null}

        {!product.in_stock ? (
          <View style={styles.soldOut}>
            <Pill label="SOLD OUT" tone="dark" />
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text variant="eyebrow" tone="faint" numberOfLines={1}>
          {product.store_display_name.toUpperCase()}
        </Text>
        <Text variant="smallMedium" numberOfLines={2} style={styles.title}>
          {product.title}
        </Text>
        <View style={styles.priceRow}>
          <Text variant="price">{ghs(product.base_price_pesewas)}</Text>
          {product.compare_at_price_pesewas ? (
            <Text variant="tiny" tone="faint" style={styles.strike}>
              {ghs(product.compare_at_price_pesewas)}
            </Text>
          ) : null}
        </View>
        {weekly ? (
          <Text variant="tiny" tone="accent" numberOfLines={1}>
            {weekly}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderSoft,
    overflow: 'hidden',
  },
  flex: { flex: 1 },
  imageWrap: { width: '100%' },
  discount: { position: 'absolute', top: space.sm, left: space.sm },
  heart: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soldOut: {
    ...fillParent,
    backgroundColor: 'rgba(245,242,237,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: space.md, gap: 3 },
  title: { minHeight: 34 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  strike: { textDecorationLine: 'line-through' },
});
