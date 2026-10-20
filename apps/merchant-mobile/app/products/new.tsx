import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { PlanTemplate } from '@installment/api-types';
import {
  Button,
  Card,
  Field,
  Header,
  Icon,
  Line,
  Note,
  SaleSplits,
  Screen,
  SectionLabel,
  Segmented,
  StickyFooter,
  Stepper,
  Text,
  ToggleRow,
} from '../../src/components';
import {
  useCreateProduct,
  useMerchantProfile,
  usePlanTemplates,
  useShopCategories,
  useUploadImage,
  type PickedImage,
} from '../../src/features/merchant';
import { saleSplits } from '../../src/lib/fees';
import { ghs, parseGhsToPesewas, pluralise } from '../../src/lib/format';
import { skusFor } from '../../src/lib/sku';
import { color, radius, space } from '../../src/theme/tokens';

const MAX_PHOTOS = 6;

/** One row of the option table: a value the buyer picks, and what is on the shelf. */
interface OptionRow {
  /** Local only — React needs a stable key while the value is still being typed. */
  key: string;
  value: string;
  quantity: number;
}

/**
 * List a product.
 *
 * One request, not five. `createProductSchema` takes the variants, the photo
 * keys and the plan offers alongside the product, and the service writes all of
 * it in a single transaction — so a listing cannot end up half-created, with
 * stock but no photographs, because a mobile connection dropped between calls.
 *
 * The photographs are the exception, and they have to be: bytes never pass
 * through the API. Each one is uploaded as it is picked, which costs an orphan
 * object in the bucket if the seller abandons the draft, and buys a Publish that
 * does not stall for thirty seconds on the last photo over a 3G connection.
 */
export default function NewProductScreen(): React.ReactElement {
  const categories = useShopCategories();
  const templates = usePlanTemplates();
  const profile = useMerchantProfile();
  const create = useCreateProduct();
  const upload = useUploadImage();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [price, setPrice] = useState('');
  const [wasPrice, setWasPrice] = useState('');
  const [photoKeys, setPhotoKeys] = useState<string[]>([]);
  const [photoUris, setPhotoUris] = useState<string[]>([]);
  const [optionName, setOptionName] = useState('');
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [singleStock, setSingleStock] = useState(1);
  const [instalments, setInstalments] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pesewas = parseGhsToPesewas(price);
  const priceTyped = price.trim().length > 0;

  /**
   * The "was" price, and the one rule the database has about it.
   *
   * `products_compare_at_above_price` has refused anything not strictly above
   * the selling price since 0015 — "a strikethrough that is not actually a
   * discount is a lie the UI would tell on every card". Checking here means a
   * seller sees it while they are typing rather than on submit.
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

  /**
   * Which plans this price can actually be sold on.
   *
   * Every eligibility rule is the platform's, not the seller's: a template has
   * its own floor and ceiling, and offering one outside them would be an offer
   * the checkout refuses. So the toggle attaches the plans the price reaches,
   * and the card names them — rather than promising "instalments" in general.
   */
  const eligible = useMemo<PlanTemplate[]>(() => {
    if (pesewas === null || !templates.data) return [];
    return templates.data.filter(
      (t) => pesewas >= t.min_amount_pesewas && pesewas <= t.max_amount_pesewas,
    );
  }, [pesewas, templates.data]);

  const offering = instalments && eligible.length > 0;
  /**
   * Each way this item can be bought, at the rates that sale is charged.
   *
   * This read `default_mdr_bps` / `default_reserve_bps` — a flat 4% and 5% —
   * which nothing has charged since migration 0009. A paid-in-full order takes
   * the marketplace commission; a plan takes its own model's rates or the
   * seller's deal. The rates are the server's (`fees`), not worked out here.
   */
  const fees = profile.data?.fees;
  const splits =
    fees && pesewas !== null
      ? saleSplits(pesewas, fees, offering ? eligible.map((t) => t.business_model) : [])
      : null;
  const nets = splits?.map((s) => s.net) ?? [];
  const keep = nets.length
    ? Math.min(...nets) === Math.max(...nets)
      ? ghs(nets[0])
      : `${ghs(Math.min(...nets))}–${ghs(Math.max(...nets))}`
    : null;

  const totalStock = options.length ? options.reduce((sum, o) => sum + o.quantity, 0) : singleStock;

  async function pickPhoto(): Promise<void> {
    if (photoKeys.length >= MAX_PHOTOS) return;
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Ejua needs your photos',
        'Allow photo access in Settings to put pictures of your stock on this listing.',
      );
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      // No editor: a seller cropping on a small screen loses the shot more often
      // than they improve it, and the storefront tile crops centrally anyway.
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
      const key = await upload.mutateAsync({ image, purpose: 'product_image' });
      setPhotoKeys((keys) => [...keys, key]);
      setPhotoUris((uris) => [...uris, asset.uri]);
    } catch (err) {
      setError(apiErrorMessage(err, 'That photo could not be uploaded.'));
    }
  }

  function removePhoto(index: number): void {
    // Only from the listing. The object stays in the bucket — a merchant token
    // cannot delete from storage, and it is unreferenced, so nothing shows it.
    setPhotoKeys((keys) => keys.filter((_, i) => i !== index));
    setPhotoUris((uris) => uris.filter((_, i) => i !== index));
  }

  const addOption = useCallback(() => {
    setOptions((rows) => [
      ...rows,
      { key: `${Date.now()}-${rows.length}`, value: '', quantity: 1 },
    ]);
  }, []);

  function publish(status: 'active' | 'draft'): void {
    setError(null);
    if (!title.trim()) return setError('Give the listing a name buyers will recognise.');
    if (pesewas === null) return setError('Enter the price as a plain amount, like 320.00.');
    if (pesewas === 0) return setError('A price of zero cannot be sold. Enter what it costs.');
    if (wasError) return setError(wasError);

    const named = options.filter((o) => o.value.trim());
    const values = named.map((o) => o.value.trim().toLowerCase());
    if (new Set(values).size !== values.length) {
      // `product_variants` is UNIQUE on (product_id, sku), and the sku is
      // derived from the value — two rows called "M" would be one 409 the
      // seller cannot read.
      return setError(`Two ${optionName.trim() || 'options'} have the same name.`);
    }

    const skus = skusFor(title, named.length ? named.map((o) => o.value) : ['default']);
    const variants = named.length
      ? named.map((o, i) => ({
          sku: skus[i]!,
          option_values: { [optionName.trim() || 'Option']: o.value.trim() },
          quantity_available: o.quantity,
        }))
      : // A product must have at least one variant to be buyable at all: the
        // cart holds variant ids, not product ids. A listing with no options
        // still gets one, unnamed.
        [{ sku: skus[0]!, quantity_available: singleStock }];

    create.mutate(
      {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
        base_price_pesewas: pesewas,
        // Omitted rather than sent as null when the seller left it blank.
        ...(wasPesewas !== null ? { compare_at_price_pesewas: wasPesewas } : {}),
        status,
        variants,
        images: photoKeys.map((storage_key, position) => ({ storage_key, position })),
        ...(offering ? { plan_template_ids: eligible.map((t) => t.id) } : {}),
      },
      {
        onSuccess: () => {
          // Back to the catalogue, not to the new product: the seller's next
          // move after listing one thing is almost always listing the next.
          router.replace('/products');
        },
        onError: (err) => setError(apiErrorMessage(err, 'The listing could not be published.')),
      },
    );
  }

  const busy = create.isPending || upload.isPending;

  return (
    <>
      <Screen footerHeight={92}>
        <Header
          back
          title="New product"
          subtitle={
            priceTyped && pesewas !== null && keep
              ? `${ghs(pesewas)} · you keep ${keep}`
              : undefined
          }
        />

        <View style={styles.body}>
          <View>
            <SectionLabel>{`Photos · ${photoKeys.length} of ${MAX_PHOTOS}`}</SectionLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.photos}>
                {photoUris.map((uri, i) => (
                  <Pressable
                    key={uri}
                    accessibilityRole="button"
                    accessibilityLabel={
                      i === 0 ? 'Remove the cover photo' : `Remove photo ${i + 1}`
                    }
                    onPress={() => removePhoto(i)}
                    style={styles.photo}
                  >
                    <Image source={{ uri }} style={styles.photoImage} contentFit="cover" />
                    <View style={styles.photoBadge}>
                      <Icon name="x" size={12} color={color.onDark} />
                    </View>
                    {i === 0 ? (
                      <View style={styles.cover}>
                        <Text variant="tiny" tone="onDark">
                          Cover
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                ))}
                {photoKeys.length < MAX_PHOTOS ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add a photo"
                    disabled={upload.isPending}
                    onPress={() => void pickPhoto()}
                    style={[styles.photo, styles.photoAdd, upload.isPending && styles.dim]}
                  >
                    <Icon name="plus" size={20} color={color.mutedSoft} />
                    <Text variant="tiny" tone="faint">
                      {upload.isPending ? 'Sending…' : 'Add'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </ScrollView>
            <Text variant="tiny" tone="faint" style={styles.lead}>
              The first photo is what buyers see in the marketplace. Tap one to remove it.
            </Text>
          </View>

          <Card style={styles.gap}>
            <Field
              label="TITLE"
              value={title}
              onChangeText={setTitle}
              placeholder="Ankara Wrap Dress · Adinkra print"
              maxLength={300}
            />
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
              placeholder="320.00"
              keyboardType="decimal-pad"
              error={priceTyped && pesewas === null ? 'Enter a plain amount, like 320.00.' : null}
            />
            <Field
              label="WAS (GHS) — OPTIONAL"
              value={wasPrice}
              onChangeText={setWasPrice}
              placeholder="400.00"
              keyboardType="decimal-pad"
              error={wasError}
            />
            <Text variant="tiny" tone="muted" style={styles.saleHint}>
              {wasPesewas !== null && pesewas !== null && wasPesewas > pesewas
                ? `Buyers see ${ghs(wasPesewas)} struck through and a ${Math.round((1 - pesewas / wasPesewas) * 100)}% off badge.`
                : 'The old price, if this is on sale. It has to be higher than what you are charging — a strikethrough that is not a real discount is not allowed.'}
            </Text>
          </Card>

          <View>
            <SectionLabel>Category</SectionLabel>
            {categories.data && categories.data.length > 0 ? (
              <Segmented
                options={categories.data.map((c) => ({ value: c.id, label: c.name }))}
                value={categoryId ?? ''}
                onChange={(id) => setCategoryId(id === categoryId ? undefined : id)}
              />
            ) : (
              <Text variant="tiny" tone="faint">
                {categories.isPending
                  ? 'Loading the marketplace categories…'
                  : 'No categories are set up yet. The listing will still publish.'}
              </Text>
            )}
            <Text variant="tiny" tone="faint" style={styles.lead}>
              Where shoppers browsing the marketplace will find this. Tap again to clear it.
            </Text>
          </View>

          <View>
            <SectionLabel>Sizes, colours or options</SectionLabel>
            <Card style={styles.gap}>
              <Field
                label="WHAT VARIES"
                value={optionName}
                onChangeText={setOptionName}
                placeholder="Size"
                maxLength={40}
                hint="Leave the list empty if this product comes one way only."
              />

              {options.length === 0 ? (
                <Stepper
                  label="In stock"
                  value={singleStock}
                  onChange={setSingleStock}
                  note={
                    singleStock === 0
                      ? 'At zero, buyers cannot add it to a basket.'
                      : pluralise(singleStock, 'available')
                  }
                />
              ) : (
                options.map((row, i) => (
                  <View key={row.key} style={styles.option}>
                    <Field
                      label={`${(optionName.trim() || 'OPTION').toUpperCase()} ${i + 1}`}
                      value={row.value}
                      onChangeText={(value) =>
                        setOptions((rows) =>
                          rows.map((r) => (r.key === row.key ? { ...r, value } : r)),
                        )
                      }
                      placeholder="M"
                      maxLength={40}
                      style={styles.optionField}
                    />
                    <Stepper
                      label={row.value.trim() || `Option ${i + 1}`}
                      value={row.quantity}
                      onChange={(quantity) =>
                        setOptions((rows) =>
                          rows.map((r) => (r.key === row.key ? { ...r, quantity } : r)),
                        )
                      }
                      note={row.quantity === 0 ? 'Hidden from buyers until you restock' : undefined}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${row.value.trim() || `option ${i + 1}`}`}
                      onPress={() => setOptions((rows) => rows.filter((r) => r.key !== row.key))}
                      style={styles.remove}
                    >
                      <Text variant="tiny" tone="accent">
                        Remove
                      </Text>
                    </Pressable>
                  </View>
                ))
              )}

              <Button
                label={options.length ? 'Add another' : 'Add sizes or options'}
                variant="outline"
                compact
                onPress={addOption}
              />
            </Card>
          </View>

          <Card dark style={styles.gap}>
            <Text variant="eyebrow" tone="onDarkMuted">
              WHAT YOU RECEIVE PER SALE
            </Text>
            <Line label="Order total" value={ghs(pesewas ?? 0)} dark />
            {splits ? (
              <SaleSplits splits={splits} dark />
            ) : (
              <Text variant="tiny" tone="onDarkFaint">
                {pesewas === null ? 'Enter a price to see what you keep.' : 'Checking your rates…'}
              </Text>
            )}
            <Text variant="tiny" tone="onDarkFaint" style={styles.lead}>
              {offering
                ? // Says nothing about WHEN, for the reason the order screen
                  // gives: MODEL_CONFIG pays BNPL and rent-to-own at approval,
                  // layaway at completion and hybrid 40/60, and releases each
                  // reserve on its own schedule. "Paid at approval" was false
                  // for two of the four rows above it.
                  'On a plan Ejua lends the buyer the money and collects every payment. If a buyer stops paying for good, the reserve covers the loss first; on hybrid and rent to own plans, the rest comes off your future payouts. When you are credited, and when what is held comes back, depends on the plan type — each order shows its own.'
                : 'A paid-in-full order settles on the next payout run, with no reserve held.'}
            </Text>
          </Card>

          <Card>
            <ToggleRow
              label="Allow instalments on this item"
              body={
                templates.isPending
                  ? 'Checking which plans your price qualifies for…'
                  : pesewas === null
                    ? 'Enter a price to see which plans it qualifies for.'
                    : eligible.length > 0
                      ? `${eligible.map((t) => t.name).join(', ')} — buyers pay over time, and Ejua collects every payment.`
                      : 'No plan covers this price. Ejua sets the floor and ceiling on each one.'
              }
              value={offering}
              // Not disabled with a silent no-op: a toggle that will not move
              // needs the sentence above it to say why, which it does.
              disabled={eligible.length === 0}
              onChange={setInstalments}
            />
          </Card>

          {error ? (
            <Note eyebrow="Not published" tone="warn">
              {error}
            </Note>
          ) : null}

          <Note eyebrow="What happens next">
            {`This goes live for shoppers as soon as it is published — there is no review step. ${
              totalStock === 0
                ? 'With nothing in stock it will be listed but not buyable.'
                : `${pluralise(totalStock, 'item')} on the shelf.`
            }`}
          </Note>
        </View>
      </Screen>

      <StickyFooter>
        <Button
          label={create.isPending ? 'Publishing…' : 'Publish to marketplace'}
          sublabel={
            pesewas === null ? 'Live for shoppers straight away' : `Buyers pay ${ghs(pesewas)}`
          }
          loading={create.isPending}
          disabled={busy}
          onPress={() => publish('active')}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => publish('draft')}
          style={styles.draft}
        >
          <Text variant="smallMedium" tone="muted">
            Save as a draft instead
          </Text>
        </Pressable>
      </StickyFooter>
    </>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  gap: { gap: space.lg },
  lead: { marginTop: space.sm, lineHeight: 16 },
  saleHint: { lineHeight: 16 },
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
  photoBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: color.scrim,
    alignItems: 'center',
    justifyContent: 'center',
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

  option: {
    gap: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
  },
  optionField: { paddingVertical: 10 },
  remove: { alignSelf: 'flex-start', paddingVertical: 2 },

  draft: { alignItems: 'center', paddingTop: space.md, paddingBottom: 2 },
});
