import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { ProductStatus, ProductVariantStock } from '@installment/api-types';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Header,
  Icon,
  Loading,
  Note,
  Pill,
  RestockSheet,
  Screen,
  SectionLabel,
  Segmented,
  Sheet,
  StickyFooter,
  Stepper,
  Text,
  variantLabel,
  type PillTone,
} from '../../src/components';
import {
  useAddProductImage,
  useAddVariant,
  useProduct,
  useShopCategories,
  useUpdateProduct,
  type PickedImage,
} from '../../src/features/merchant';
import { cedis, ghs, parseGhsToPesewas, pluralise } from '../../src/lib/format';
import { skusFor } from '../../src/lib/sku';
import { color, radius, space, tintFor } from '../../src/theme/tokens';

/**
 * What each status means to the seller, in their words rather than the
 * column's.
 *
 * There is no delete. `archived` is how a listing is retired — the order
 * history behind it has to keep pointing at a product row, and a hard delete
 * would orphan every sale of it.
 */
const STATUSES: { value: ProductStatus; label: string; note: string }[] = [
  { value: 'active', label: 'On sale', note: 'Buyers can find and buy this.' },
  { value: 'draft', label: 'Off sale', note: 'Hidden from the marketplace. Nothing is lost.' },
  { value: 'archived', label: 'Retired', note: 'Put away for good. Past orders are unaffected.' },
];

export default function ProductScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const product = useProduct(id);
  const update = useUpdateProduct(id);
  const categories = useShopCategories();
  const addImage = useAddProductImage(id);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [wasPrice, setWasPrice] = useState('');
  const [status, setStatus] = useState<ProductStatus>('draft');
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [restocking, setRestocking] = useState(false);
  const [addingVariant, setAddingVariant] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const p = product.data;
  const savedTitle = p?.title ?? '';
  const savedDescription = p?.description ?? '';
  const savedPrice = p ? cedis(p.base_price_pesewas).replace(/,/g, '') : '';
  const savedWas = p?.compare_at_price_pesewas
    ? cedis(p.compare_at_price_pesewas).replace(/,/g, '')
    : '';
  const savedStatus = p?.status ?? 'draft';
  const savedCategory = p?.category_id ?? undefined;

  // The six values, never the query result: React Query hands back a new
  // object on every background refetch, and depending on it would wipe a
  // half-typed price.
  useEffect(() => {
    setTitle(savedTitle);
    setDescription(savedDescription);
    setPrice(savedPrice);
    setWasPrice(savedWas);
    setStatus(savedStatus);
    setCategoryId(savedCategory);
  }, [savedTitle, savedDescription, savedPrice, savedWas, savedStatus, savedCategory]);

  const pesewas = parseGhsToPesewas(price);

  /**
   * The "was" price, checked against the price in the SAME form.
   *
   * `products_compare_at_above_price` refuses anything not strictly above the
   * selling price, and on an edit either half can move — raising the price past
   * an untouched "was" breaks the row just as surely as lowering the "was"
   * does. The service re-checks the merged row for the same reason; this is so
   * the seller sees it while typing.
   */
  const wasTyped = wasPrice.trim().length > 0;
  const wasPesewas = wasTyped ? parseGhsToPesewas(wasPrice) : null;
  const wasError = !wasTyped
    ? null
    : wasPesewas === null
      ? 'Enter a plain amount, like 400.00.'
      : pesewas !== null && wasPesewas <= pesewas
        ? 'The old price has to be higher than what you are charging now.'
        : null;

  const dirty = useMemo(
    () =>
      title !== savedTitle ||
      description !== savedDescription ||
      price !== savedPrice ||
      wasPrice !== savedWas ||
      status !== savedStatus ||
      categoryId !== savedCategory,
    [
      title,
      description,
      price,
      wasPrice,
      status,
      categoryId,
      savedTitle,
      savedDescription,
      savedPrice,
      savedWas,
      savedStatus,
      savedCategory,
    ],
  );

  async function pickPhoto(): Promise<void> {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Ejua needs your photos',
        'Allow photo access in Settings to add a picture to this listing.',
      );
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: false,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const image: PickedImage = {
      uri: asset.uri,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    };
    try {
      await addImage.mutateAsync(image);
    } catch (err) {
      setError(apiErrorMessage(err, 'That photo could not be added.'));
    }
  }

  function save(): void {
    setError(null);
    if (!title.trim()) return setError('A listing needs a name buyers will recognise.');
    if (pesewas === null) return setError('Enter the price as a plain amount, like 320.00.');
    if (pesewas === 0) return setError('A price of zero cannot be sold.');
    if (wasError) return setError(wasError);
    update.mutate(
      {
        title: title.trim(),
        // Nullable on the wire, so an emptied description actually clears the
        // column rather than leaving the old text on the storefront.
        description: description.trim() || null,
        base_price_pesewas: pesewas,
        // Null, not omitted: clearing the box has to end the sale rather than
        // silently leave the old strikethrough on every card.
        compare_at_price_pesewas: wasPesewas,
        status,
        category_id: categoryId ?? null,
      },
      { onError: (err) => setError(apiErrorMessage(err, 'That could not be saved.')) },
    );
  }

  if (product.isPending) {
    return (
      <Screen>
        <Header back title="Listing" />
        <Loading />
      </Screen>
    );
  }

  if (product.error || !p) {
    return (
      <Screen>
        <Header back title="Listing" />
        <ErrorState
          message={apiErrorMessage(product.error, 'Could not load this listing.')}
          onRetry={() => void product.refetch()}
        />
      </Screen>
    );
  }

  const variants: ProductVariantStock[] = p.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    option_values: v.option_values,
    price_pesewas: v.price_pesewas,
    quantity_available: v.inventory?.quantity_available ?? 0,
    restock_threshold: v.inventory?.restock_threshold ?? 0,
  }));
  const onShelf = variants.reduce((n, v) => n + v.quantity_available, 0);
  const outOfStock = variants.filter((v) => v.quantity_available === 0).length;

  return (
    <>
      <Screen
        footerHeight={dirty ? 92 : 0}
        refreshing={product.isFetching}
        onRefresh={() => void product.refetch()}
      >
        <Header
          back
          title={p.title}
          subtitle={`${ghs(p.base_price_pesewas)} · ${pluralise(onShelf, 'in stock', 'in stock')}`}
          right={
            p.taken_down_at ? (
              <Pill label="TAKEN DOWN" tone="warn" />
            ) : (
              <Pill label={statusLabel(p.status)} tone={statusTone(p.status)} />
            )
          }
        />

        <View style={styles.body}>
          <View>
            <SectionLabel>{`Photos · ${p.images.length}`}</SectionLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.photos}>
                {p.images.map((image, i) =>
                  image.url ? (
                    <View key={image.id} style={styles.photo}>
                      <Image
                        source={{ uri: image.url }}
                        style={styles.photoImage}
                        contentFit="cover"
                      />
                      {i === 0 ? (
                        <View style={styles.cover}>
                          <Text variant="tiny" tone="onDark">
                            Cover
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  ) : (
                    // No storage configured in this deployment: a tinted tile
                    // rather than a broken image.
                    <View
                      key={image.id}
                      style={[styles.photo, { backgroundColor: tintFor(image.id) }]}
                    />
                  ),
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add a photo"
                  disabled={addImage.isPending}
                  onPress={() => void pickPhoto()}
                  style={[styles.photo, styles.photoAdd, addImage.isPending && styles.dim]}
                >
                  <Icon name="plus" size={20} color={color.mutedSoft} />
                  <Text variant="tiny" tone="faint">
                    {addImage.isPending ? 'Sending…' : 'Add'}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
            {/* Removing one is not offered because nothing serves it: there is
                no DELETE on product images, and a control that silently failed
                would be worse than its absence. */}
            <Text variant="tiny" tone="faint" style={styles.lead}>
              The first photo is what buyers see in the marketplace.
            </Text>
          </View>

          <Card style={styles.gap}>
            <Field label="TITLE" value={title} onChangeText={setTitle} maxLength={300} />
            <Field
              label="DESCRIPTION"
              value={description}
              onChangeText={setDescription}
              placeholder="Fabric, fit, how long it takes you to make one."
              multiline
              maxLength={20_000}
              style={styles.multiline}
            />
            <Field
              label="PRICE (GHS)"
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
              error={price.trim() && pesewas === null ? 'Enter a plain amount, like 320.00.' : null}
              hint={
                pesewas !== null && p && pesewas !== p.base_price_pesewas
                  ? `Was ${ghs(p.base_price_pesewas)}. A price change does not affect orders already placed.`
                  : undefined
              }
            />
            <Field
              label="WAS (GHS) — OPTIONAL"
              value={wasPrice}
              onChangeText={setWasPrice}
              placeholder="400.00"
              keyboardType="decimal-pad"
              error={wasError}
              hint={
                wasPesewas !== null && pesewas !== null && wasPesewas > pesewas
                  ? `Buyers see ${ghs(wasPesewas)} struck through and ${Math.round((1 - pesewas / wasPesewas) * 100)}% off.`
                  : savedWas
                    ? 'Clear this to end the sale.'
                    : 'The old price, if this is on sale.'
              }
            />
          </Card>

          <View>
            <SectionLabel>Category</SectionLabel>
            {categories.data && categories.data.length > 0 ? (
              <Segmented
                options={categories.data.map((c) => ({ value: c.id, label: c.name }))}
                value={categoryId ?? ''}
                onChange={(next) => setCategoryId(next === categoryId ? undefined : next)}
              />
            ) : (
              <Text variant="tiny" tone="faint">
                {categories.isPending ? 'Loading…' : 'No categories are set up yet.'}
              </Text>
            )}
          </View>

          {/* Taken down by Ejua: the status is not the seller's to change until
              that is lifted (the API refuses it), so the picker gives way to
              why, and what to do about it. */}
          {p.taken_down_at ? (
            <View>
              <SectionLabel>On sale?</SectionLabel>
              <Note eyebrow="Taken down by Ejua" tone="warn">
                {`${p.taken_down_reason ?? 'This listing was taken down.'} It is off the marketplace until Ejua lifts this. You can still edit the listing — fix what is wrong, then contact Ejua support to have it reviewed.`}
              </Note>
            </View>
          ) : (
            <View>
              <SectionLabel>On sale?</SectionLabel>
              <Card bare style={styles.rows}>
                {STATUSES.map((option, i) => {
                  const on = option.value === status;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${option.label}. ${option.note}`}
                      onPress={() => setStatus(option.value)}
                      style={[styles.statusRow, i > 0 && styles.divided]}
                    >
                      <View style={[styles.radio, on && styles.radioOn]}>
                        {on ? <View style={styles.radioDot} /> : null}
                      </View>
                      <View style={styles.statusText}>
                        <Text variant="smallMedium">{option.label}</Text>
                        <Text variant="tiny" tone="faint">
                          {option.note}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </Card>
            </View>
          )}

          <View>
            <SectionLabel>{`Sizes and stock · ${pluralise(variants.length, 'size')}`}</SectionLabel>
            <Card style={styles.gap}>
              {variants.length === 0 ? (
                <Text variant="small" tone="muted">
                  {/* The cart holds variant ids, not product ids, so a product
                      with none cannot be added to a basket at all — whatever
                      its status says. */}
                  This listing has no sizes, so buyers cannot add it to a basket at all. Add one to
                  make it buyable.
                </Text>
              ) : (
                <>
                  <View style={styles.chips}>
                    {variants.map((v) => (
                      <View
                        key={v.id}
                        style={[styles.chip, v.quantity_available === 0 && styles.chipOut]}
                      >
                        <Text variant="tiny" tone={v.quantity_available === 0 ? 'accent' : 'soft'}>
                          {variantLabel(v)}
                        </Text>
                        <Text variant="tiny" tone={v.quantity_available === 0 ? 'accent' : 'faint'}>
                          {v.quantity_available === 0 ? 'out' : String(v.quantity_available)}
                        </Text>
                      </View>
                    ))}
                  </View>
                  {outOfStock > 0 ? (
                    <Text variant="tiny" tone="accent">
                      {`${outOfStock} of ${variants.length} hidden from buyers until restocked.`}
                    </Text>
                  ) : null}
                  <Button
                    label="Update stock"
                    variant="outline"
                    compact
                    onPress={() => setRestocking(true)}
                  />
                </>
              )}
              <Button
                label="Add a size"
                variant="outline"
                compact
                onPress={() => setAddingVariant(true)}
              />
            </Card>
          </View>

          {error ? (
            <Note eyebrow="Not saved" tone="warn">
              {error}
            </Note>
          ) : null}

          <Note eyebrow="What cannot change here">
            {/* Both are real constraints, not omissions: `updateProductSchema`
                has no `store_id`, and there is no delete route at all. */}
            A listing cannot be moved to another shop — its settlement history is attached to this
            one — and it cannot be deleted. Retiring it is what takes it away for good without
            breaking past orders.
          </Note>
        </View>
      </Screen>

      {dirty ? (
        <StickyFooter>
          <Button
            label={update.isPending ? 'Saving…' : 'Save changes'}
            loading={update.isPending}
            disabled={update.isPending}
            onPress={save}
          />
        </StickyFooter>
      ) : null}

      <RestockSheet
        open={restocking}
        onClose={() => setRestocking(false)}
        productId={p.id}
        productTitle={p.title}
        variants={variants}
      />

      <AddVariantSheet
        open={addingVariant}
        onClose={() => setAddingVariant(false)}
        productId={p.id}
        productTitle={p.title}
        existing={variants}
      />
    </>
  );
}

/**
 * Adding a size to a listing that is already live.
 *
 * Its own route (`POST products/:id/variants`) rather than part of the patch,
 * because a variant carries an inventory row with it and the two are written
 * together server-side.
 */
function AddVariantSheet({
  open,
  onClose,
  productId,
  productTitle,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  productId: string;
  productTitle: string;
  existing: ProductVariantStock[];
}): React.ReactElement {
  const add = useAddVariant(productId);
  const [name, setName] = useState('');
  const [optionName, setOptionName] = useState('Size');
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Reuse whatever the existing variants call their option, so a listing that
  // varies by Colour does not silently gain one that varies by Size. Reduced to
  // a string first: `existing` is a fresh array on every render of the parent,
  // and an effect depending on it would clear the name field as it was typed.
  const existingOption = Object.keys(existing[0]?.option_values ?? {})[0] ?? 'Size';

  useEffect(() => {
    if (!open) return;
    setName('');
    setQuantity(1);
    setError(null);
    setOptionName(existingOption);
  }, [open, existingOption]);

  function submit(): void {
    setError(null);
    const value = name.trim();
    if (!value) return setError('Give the size a name buyers will recognise.');
    if (existing.some((v) => variantLabel(v).toLowerCase() === value.toLowerCase())) {
      return setError(`This listing already has a ${value}.`);
    }
    add.mutate(
      {
        // Clear of the codes the listing already has: the value alone collided
        // ("Red/Blue" beside "Red Blue") or slugged to nothing ("ɔ"), and the
        // seller got a 409 about a SKU they had never typed.
        sku: skusFor(
          productTitle,
          [value],
          existing.map((v) => v.sku),
        )[0]!,
        option_values: { [optionName || 'Option']: value },
        quantity_available: quantity,
      },
      {
        onSuccess: onClose,
        onError: (err) => setError(apiErrorMessage(err, 'That size could not be added.')),
      },
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a size"
      subtitle={productTitle}
      footer={
        <Button
          label={add.isPending ? 'Adding…' : 'Add it'}
          loading={add.isPending}
          disabled={add.isPending}
          onPress={submit}
        />
      }
    >
      <Field
        label="WHAT VARIES"
        value={optionName}
        onChangeText={setOptionName}
        placeholder="Size"
        maxLength={40}
      />
      <Field label="NAME" value={name} onChangeText={setName} placeholder="XL" maxLength={40} />
      <Stepper
        label="In stock"
        value={quantity}
        onChange={setQuantity}
        note={quantity === 0 ? 'Added but hidden from buyers until you restock.' : undefined}
      />
      {error ? (
        <Text variant="tiny" tone="accent">
          {error}
        </Text>
      ) : null}
    </Sheet>
  );
}

function statusLabel(status: ProductStatus): string {
  return STATUSES.find((s) => s.value === status)?.label.toUpperCase() ?? status.toUpperCase();
}

function statusTone(status: ProductStatus): PillTone {
  return status === 'active' ? 'primary' : status === 'draft' ? 'warn' : 'neutral';
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  gap: { gap: space.lg },
  lead: { marginTop: space.sm, lineHeight: 16 },
  multiline: { minHeight: 78, textAlignVertical: 'top' },

  photos: { flexDirection: 'row', gap: space.sm, paddingRight: space.lg },
  photo: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.surfaceWarm,
  },
  photoImage: { width: '100%', height: '100%' },
  photoAdd: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.borderStrong,
  },
  cover: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 3,
    alignItems: 'center',
    backgroundColor: color.scrim,
  },
  dim: { opacity: 0.5 },

  rows: { paddingHorizontal: space.lg },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 13 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.primary },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: color.primary },
  statusText: { flex: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunk,
  },
  chipOut: { backgroundColor: color.accentTint },
});
