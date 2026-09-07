import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { ProductVariantStock } from '@installment/api-types';
import { Button } from './Button';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { useSetStock } from '../features/merchant';
import { color, font, radius, space } from '../theme/tokens';

/** The quick-add chips the canvas draws under the stepper. */
const QUICK = [5, 10, 25, 50] as const;

export interface RestockSheetProps {
  open: boolean;
  onClose: () => void;
  productId: string;
  productTitle: string;
  variants: ProductVariantStock[];
}

/** How a variant is named on the tab: its option values, or its SKU. */
export function variantLabel(variant: ProductVariantStock): string {
  const values = Object.values(variant.option_values ?? {})
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map(String);
  return values.length > 0 ? values.join(' · ') : variant.sku;
}

/**
 * Setting what is on the shelf.
 *
 * One variant at a time and saved on its own, rather than a form over all of
 * them: the write is `PUT /merchant/variants/:id/inventory`, one call per
 * variant, and batching them in the UI would mean a partial failure the seller
 * cannot see the shape of. Saving each keeps the sheet open so the next size is
 * one tap away, which is also how a seller actually counts stock.
 *
 * The count is absolute, not a delta. The sheet shows a number and saves that
 * number — `adjust` exists for callers that genuinely have a delta, and a delta
 * here would be wrong the moment two people are looking at the same shop.
 */
export function RestockSheet({
  open,
  onClose,
  productId,
  productTitle,
  variants,
}: RestockSheetProps): React.ReactElement {
  const setStock = useSetStock(productId);
  const [selected, setSelected] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);

  const variant = variants.find((v) => v.id === selected) ?? variants[0];

  // Re-seeded whenever the sheet opens or the seller switches variant, and from
  // the server's count rather than a local tally — a background refetch after
  // one save must leave the next variant showing what the shelf actually says.
  //
  // The two dependencies are PRIMITIVES. `variants` is rebuilt by a `.map()` in
  // the caller, so the object this finds is a new reference on every render;
  // depending on it would re-seed the stepper continuously and a seller could
  // never step past the count they started on.
  const variantId = variant?.id;
  const variantStock = variant?.quantity_available;
  useEffect(() => {
    if (!open || variantId === undefined || variantStock === undefined) return;
    setSelected(variantId);
    setQuantity(variantStock);
    setSaved(null);
  }, [open, variantId, variantStock]);

  if (!variant) {
    return (
      <Sheet open={open} onClose={onClose} title="No sizes to restock" subtitle={productTitle}>
        <Text variant="small" tone="muted">
          This listing has no variants, so there is nothing to count. Add one from the listing
          itself.
        </Text>
      </Sheet>
    );
  }

  const label = variantLabel(variant);
  const dirty = quantity !== variant.quantity_available;

  function save(): void {
    if (!variant) return;
    setStock.mutate({ variantId: variant.id, quantity }, { onSuccess: () => setSaved(label) });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Update stock"
      subtitle={productTitle}
      footer={
        <>
          <Button
            label={
              setStock.isPending
                ? 'Saving…'
                : quantity === 0
                  ? `Save · hide ${label}`
                  : `Save · ${quantity} × ${label}`
            }
            loading={setStock.isPending}
            disabled={!dirty || setStock.isPending}
            onPress={save}
          />
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.done}>
            <Text variant="smallMedium" tone="muted">
              Done
            </Text>
          </Pressable>
        </>
      }
    >
      {variants.length > 1 ? (
        <View style={styles.tabs}>
          {variants.map((v) => {
            const on = v.id === variant.id;
            const out = v.quantity_available === 0;
            return (
              <Pressable
                key={v.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${variantLabel(v)}, ${v.quantity_available} in stock`}
                onPress={() => {
                  setSelected(v.id);
                  setQuantity(v.quantity_available);
                  setSaved(null);
                }}
                style={[styles.tab, on ? styles.tabOn : out ? styles.tabOut : styles.tabOff]}
              >
                <Text
                  variant="tiny"
                  style={{ color: on ? color.onDark : out ? color.accent : color.inkSoft }}
                >
                  {variantLabel(v)}
                </Text>
                <Text
                  variant="tiny"
                  style={{ color: on ? color.onDarkMuted : out ? color.accent : color.mutedSoft }}
                >
                  {v.quantity_available}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.counter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="One fewer"
          disabled={quantity <= 0}
          onPress={() => setQuantity((n) => Math.max(0, n - 1))}
          style={[styles.big, quantity <= 0 && styles.bigOff]}
        >
          <Icon name="minus" size={22} color={color.ink} />
        </Pressable>
        <View style={styles.readout}>
          <Text style={styles.count}>{quantity}</Text>
          <Text variant="eyebrow" tone="faint">
            {label.toUpperCase()}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="One more"
          onPress={() => setQuantity((n) => n + 1)}
          style={styles.big}
        >
          <Icon name="plus" size={22} color={color.ink} />
        </Pressable>
      </View>

      <View style={styles.quick}>
        {QUICK.map((n) => (
          <Pressable
            key={n}
            accessibilityRole="button"
            accessibilityLabel={`Add ${n}`}
            onPress={() => setQuantity((q) => q + n)}
            style={styles.quickChip}
          >
            <Text variant="smallMedium">{`+${n}`}</Text>
          </Pressable>
        ))}
      </View>

      <Text variant="tiny" tone={quantity === 0 ? 'accent' : 'faint'} style={styles.note}>
        {quantity === 0
          ? // Not "delisted": the product stays live and its other sizes stay
            // buyable. `list()` treats an empty variant as unbuyable, not the
            // product as gone.
            `At zero, ${label} is hidden from buyers — the rest of the listing stays live.`
          : `Buyers see this straight away. Ejua warns you again when ${label} drops to ${variant.restock_threshold}.`}
      </Text>

      {setStock.isError ? (
        <Text variant="tiny" tone="accent">
          {apiErrorMessage(setStock.error, 'That could not be saved.')}
        </Text>
      ) : saved ? (
        <Text variant="tiny" tone="primary">
          {`${saved} saved.`}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  tabOn: { backgroundColor: color.ink, borderColor: color.ink },
  tabOff: { backgroundColor: color.surfaceSunk, borderColor: 'transparent' },
  tabOut: { backgroundColor: color.accentTint, borderColor: 'transparent' },

  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  big: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigOff: { opacity: 0.4 },
  readout: { flex: 1, alignItems: 'center', gap: space.xs },
  count: { fontFamily: font.extrabold, fontSize: 34, color: color.ink, letterSpacing: -1.4 },

  quick: { flexDirection: 'row', gap: space.sm },
  quickChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunk,
  },

  note: { lineHeight: 16 },
  done: { alignItems: 'center', paddingVertical: space.sm },
});
