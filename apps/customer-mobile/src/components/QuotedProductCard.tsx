import React from 'react';
import { Dimensions } from 'react-native';
import { ProductCard } from './ProductCard';
import { bestQuote, usePlanQuote } from '../features/storefront';
import { cadenceNoun, ghs } from '../lib/format';
import { space } from '../theme/tokens';
import type { StorefrontProduct } from '../features/types';

/**
 * Two columns with a gutter, measured rather than flexed.
 *
 * `flex: 1` inside a wrapping row does not make a grid — the last row of an
 * odd-length list stretches its single card to full width. An explicit width
 * keeps every tile the same size whatever the count.
 */
export const GRID_WIDTH = (Dimensions.get('window').width - space.lg * 2 - space.md) / 2;

export interface QuotedProductCardProps {
  product: StorefrontProduct;
  width?: number;
  compact?: boolean;
  saved?: boolean;
  onToggleSave?: () => void;
}

/**
 * A product card carrying its "or GHS X/week" line.
 *
 * The quote is fetched rather than computed: the engine's generator spreads a
 * rounding remainder across the earliest instalments, so dividing the price here
 * would disagree with the schedule the customer is shown at checkout. Quotes are
 * cached by amount, so a grid of similarly-priced items makes far fewer requests
 * than it has cards.
 *
 * Every grid in the app — home, browse, search, a vendor's shelf — renders
 * through this, so the four cannot drift apart.
 */
export function QuotedProductCard({
  product,
  width,
  compact,
  saved,
  onToggleSave,
}: QuotedProductCardProps): React.ReactElement {
  // Passing 0 disables the query outright for a product with no instalment
  // offer, rather than asking for a quote that would come back ineligible.
  const quotes = usePlanQuote(product.installment_eligible ? product.base_price_pesewas : 0);
  const best = bestQuote(quotes.data);

  return (
    <ProductCard
      product={product}
      width={width}
      compact={compact}
      saved={saved}
      onToggleSave={onToggleSave}
      weekly={
        best
          ? `or ${ghs(best.per_installment_pesewas)}/${cadenceNoun(best.installment_frequency_days)}`
          : null
      }
    />
  );
}
