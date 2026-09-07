import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  GHANA_REGIONS,
  type GhanaRegion,
  type MerchantKycDocType,
  type MerchantKycStatus,
  type PayoutDestination,
} from '@installment/api-types';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Header,
  Line,
  Loading,
  Note,
  Screen,
  StatusDot,
  StickyFooter,
  Text,
  Total,
} from '../src/components';
import {
  isNoStoreYet,
  useKycStatus,
  useMerchantProfile,
  useMerchantStore,
  usePayoutAccount,
  usePayoutDestinations,
  useResolvePayoutAccount,
  useSetPayoutAccount,
  useShopCategories,
  useSubmitKycDocument,
  useUpdateMerchantStore,
  type PickedImage,
} from '../src/features/merchant';
import { ghs } from '../src/lib/format';
import { color, radius, space } from '../src/theme/tokens';

type Step = 1 | 2 | 3;

/**
 * The documents Ejua has to approve before a shop can trade, in the order a
 * seller can actually produce them.
 *
 * `business_registration` is not here on purpose: it is accepted as extra
 * evidence but never required, because a market trader with a stall and a Ghana
 * Card is exactly who this marketplace is for. The gate in
 * `REQUIRED_MERCHANT_KYC_DOCS` says the same three.
 */
const DOCS: { type: MerchantKycDocType; label: string; hint: string }[] = [
  { type: 'ghana_card_front', label: 'Ghana Card · front', hint: 'The side with your photograph' },
  { type: 'ghana_card_back', label: 'Ghana Card · back', hint: 'The side with the barcode' },
  { type: 'shop_photo', label: 'Your shop or stall', hint: 'One clear photo of where you sell' },
];

const TITLES: Record<Step, string> = {
  1: 'Tell buyers who you are',
  2: 'Verify your business',
  3: 'Where the money lands',
};

/**
 * Setting up a shop.
 *
 * Not registration — that happens on the web, and by the time this screen can
 * be reached there is an account, a merchant and (almost always) a `draft`
 * store. What is missing is everything an admin needs before they can turn the
 * shop on: a name and a market buyers can recognise, three approved documents,
 * and a payout destination the bank has confirmed.
 *
 * There is no "Open my shop" button, whatever the canvas draws. Going live is
 * two transitions — `merchants.activate` and `stores.activate` — and both are
 * admin-only, deliberately: the second requires the first, and the first
 * requires a person to have looked at a Ghana Card. A button here that appeared
 * to do it would be a button that does nothing.
 */
export default function OnboardingScreen(): React.ReactElement {
  const [step, setStep] = useState<Step>(1);
  const store = useMerchantStore();
  const kyc = useKycStatus();

  // Opens on the first thing still outstanding, rather than always at step one:
  // a seller coming back from "2 documents outstanding" on the shop screen
  // should land on the documents.
  useEffect(() => {
    if (!store.data || !kyc.data) return;
    setStep((current) => {
      if (current !== 1) return current;
      if (!store.data.city || !store.data.primary_category_id) return 1;
      if (!kyc.data.complete && !kyc.data.exempt) return 2;
      return 3;
    });
  }, [store.data, kyc.data]);

  if (store.isPending) {
    return (
      <Screen dark>
        <Header dark back title="Set up your shop" />
        <Loading dark />
      </Screen>
    );
  }

  if (store.error) {
    return (
      <Screen dark>
        <Header dark back title="Set up your shop" />
        <ErrorState
          message={
            isNoStoreYet(store.error)
              ? 'There is no shopfront on this account yet. Ejua support can add one — nothing you have sold is affected.'
              : apiErrorMessage(store.error, 'Could not load your shop.')
          }
          onRetry={() => void store.refetch()}
        />
      </Screen>
    );
  }

  return (
    <>
      <Screen dark footerHeight={86}>
        <Header dark back title="Set up your shop" />
        <View style={styles.body}>
          <View>
            <Text variant="eyebrowLg" tone="primary">
              {`STEP ${step} OF 3`}
            </Text>
            <Text variant="h1" tone="onDark" style={styles.title}>
              {TITLES[step]}
            </Text>
            <View style={styles.bars}>
              {[1, 2, 3].map((n) => (
                <View key={n} style={[styles.bar, n <= step ? styles.barOn : styles.barOff]} />
              ))}
            </View>
          </View>

          {step === 1 ? <Identity /> : null}
          {step === 2 ? <Documents /> : null}
          {step === 3 ? <Payout /> : null}
        </View>
      </Screen>

      <StickyFooter dark>
        {step < 3 ? (
          <Button label="Continue" onPress={() => setStep((s) => (s + 1) as Step)} />
        ) : (
          <Button label="Back to my shop" onPress={() => router.replace('/shop')} />
        )}
        {step > 1 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep((s) => (s - 1) as Step)}
            style={styles.back}
          >
            <Text variant="smallMedium" tone="onDarkMuted">
              Back a step
            </Text>
          </Pressable>
        ) : null}
      </StickyFooter>
    </>
  );
}

/** Step 1 — the name, the trade and the market. */
function Identity(): React.ReactElement | null {
  const store = useMerchantStore();
  const update = useUpdateMerchantStore();
  const categories = useShopCategories();
  const s = store.data;

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState<GhanaRegion | ''>('');
  const [categorySlug, setCategorySlug] = useState('');

  // The store row carries the category as a foreign key and the wire speaks
  // slugs, so the current value is looked up rather than held in two places.
  const currentSlug = useMemo(
    () => (categories.data ?? []).find((c) => c.id === s?.primary_category_id)?.slug ?? '',
    [categories.data, s?.primary_category_id],
  );

  const savedName = s?.display_name ?? '';
  const savedCity = s?.city ?? '';
  const savedRegion = (s?.region ?? '') as GhanaRegion | '';

  // The three values, not the query result: a background refetch hands back a
  // new object, and depending on it would wipe a half-typed shop name.
  useEffect(() => {
    setName(savedName);
    setCity(savedCity);
    setRegion(savedRegion);
  }, [savedName, savedCity, savedRegion]);

  useEffect(() => setCategorySlug(currentSlug), [currentSlug]);

  if (!s) return null;

  const dirty =
    name !== savedName ||
    city !== savedCity ||
    region !== savedRegion ||
    categorySlug !== currentSlug;

  return (
    <View style={styles.step}>
      <Text variant="small" tone="onDarkMuted" style={styles.blurb}>
        Your shop name and what you sell decide where buyers find you in the marketplace. Your
        market is the only thing on your shopfront that says whether you are nearby.
      </Text>

      <Field
        dark
        label="SHOP NAME"
        value={name}
        onChangeText={setName}
        placeholder="Adepa Couture"
        maxLength={200}
      />

      <View>
        <Text variant="eyebrow" tone="onDarkFaint">
          WHAT YOU SELL
        </Text>
        {categories.data && categories.data.length > 0 ? (
          <View style={styles.chips}>
            {categories.data.map((c) => {
              const on = c.slug === categorySlug;
              return (
                <Pressable
                  key={c.slug}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setCategorySlug(on ? '' : c.slug)}
                  style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
                >
                  <Text variant="tiny" tone={on ? 'onDark' : 'onDarkMuted'}>
                    {c.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text variant="tiny" tone="onDarkFaint" style={styles.lead}>
            {categories.isPending ? 'Loading…' : 'No categories are set up yet.'}
          </Text>
        )}
      </View>

      <Field
        dark
        label="TOWN OR MARKET"
        value={city}
        onChangeText={setCity}
        placeholder="Makola, Accra"
        maxLength={120}
      />

      <View>
        <Text variant="eyebrow" tone="onDarkFaint">
          REGION
        </Text>
        <View style={styles.chips}>
          {GHANA_REGIONS.map((r) => {
            const on = r === region;
            return (
              <Pressable
                key={r}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setRegion(on ? '' : r)}
                style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
              >
                <Text variant="tiny" tone={on ? 'onDark' : 'onDarkMuted'}>
                  {r}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text variant="tiny" tone="onDarkFaint" style={styles.lead}>
        {/* The slug is derived from the shop name at signup and is never
            editable here: it is the public URL, and renaming it breaks every
            link already shared and every QR code already printed. */}
        {`Buyers reach you at ejua.shop/${s.slug}. That address is fixed — ask Ejua if it needs changing.`}
      </Text>

      {update.isError ? (
        <Text variant="tiny" tone="accent">
          {apiErrorMessage(update.error, 'Could not save that.')}
        </Text>
      ) : null}

      <Button
        label={update.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        variant={dirty ? 'primary' : 'outline'}
        disabled={!dirty || update.isPending || !name.trim()}
        onPress={() =>
          update.mutate({
            display_name: name.trim(),
            city: city.trim() || null,
            region: region || null,
            ...(categorySlug ? { primary_category_slug: categorySlug } : {}),
          })
        }
      />
    </View>
  );
}

/** Step 2 — the three documents an admin has to approve. */
function Documents(): React.ReactElement {
  const kyc = useKycStatus();
  const submit = useSubmitKycDocument();
  const [busyWith, setBusyWith] = useState<MerchantKycDocType | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(docType: MerchantKycDocType): Promise<void> {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    // Falls back to the library rather than dead-ending: a seller may have
    // photographed their card already, and refusing the camera must not mean
    // refusing to be verified.
    const useCamera = permission.granted;
    if (!useCamera) {
      const library = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!library.granted) {
        Alert.alert(
          'Ejua needs a photo',
          'Allow camera or photo access in Settings to send this document.',
        );
        return;
      }
    }
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      // Cropping is worth it here and not on a product photo: a reviewer has to
      // read the card number, and the quality cap keeps a 12MP original off a
      // Ghanaian mobile connection for no extra legibility.
      allowsEditing: true,
      quality: 0.7,
    };
    const picked = useCamera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const image: PickedImage = {
      uri: asset.uri,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    };

    setBusyWith(docType);
    try {
      await submit.mutateAsync({ image, docType });
    } catch (err) {
      setError(apiErrorMessage(err, 'That document could not be sent.'));
    } finally {
      setBusyWith(null);
    }
  }

  if (kyc.isPending) return <Loading dark />;
  if (kyc.error || !kyc.data) {
    return (
      <ErrorState
        message={apiErrorMessage(kyc.error, 'Could not load your documents.')}
        onRetry={() => void kyc.refetch()}
      />
    );
  }

  return (
    <View style={styles.step}>
      <Text variant="small" tone="onDarkMuted" style={styles.blurb}>
        A Ghana Card and a photo of where you sell are what Ejua checks before your first payout.
        Reviews finish within one working day.
      </Text>

      {DOCS.map((doc) => (
        <DocumentRow
          key={doc.type}
          doc={doc}
          status={kyc.data}
          busy={busyWith === doc.type}
          onPress={() => void send(doc.type)}
        />
      ))}

      {error ? (
        <Text variant="tiny" tone="accent">
          {error}
        </Text>
      ) : null}

      {kyc.data.exempt ? (
        <Note eyebrow="Already trading" tone="primary">
          Your shop was activated before document review existed, so nothing here is blocking you.
          Sending them anyway is still worth doing.
        </Note>
      ) : kyc.data.complete ? (
        <Note eyebrow="All approved" tone="primary">
          Everything Ejua needs has been approved. Activating the shop itself is Ejua&apos;s last
          step, not a button here.
        </Note>
      ) : (
        <Note eyebrow="What happens after">
          {/* Deliberately not "your shop goes live": approval of the documents
              satisfies the gate on `merchants.activate`, which a person still
              has to press. Promising more than that would be a lie a seller
              would notice the next morning. */}
          Once these are approved, Ejua can activate your shop. Until then you can list products and
          set everything up — buyers just cannot see the shop yet.
        </Note>
      )}
    </View>
  );
}

function DocumentRow({
  doc,
  status,
  busy,
  onPress,
}: {
  doc: (typeof DOCS)[number];
  status: MerchantKycStatus;
  busy: boolean;
  onPress: () => void;
}): React.ReactElement {
  // The newest submission for this type is the one that counts: a rejected
  // document can be replaced, and the old row stays for the audit trail.
  const latest = status.documents
    .filter((d) => d.doc_type === doc.type)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  const state = latest?.status;
  const tone = state === 'approved' ? 'primary' : state === 'rejected' ? 'accent' : 'warn';
  const action = busy
    ? 'Sending…'
    : state === 'approved'
      ? 'Approved'
      : state === 'rejected'
        ? 'Send again'
        : state === 'submitted'
          ? 'Being checked'
          : 'Add';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${doc.label}. ${doc.hint}. ${action}`}
      // An approved document is not re-openable: replacing it would drop the
      // merchant back behind the activation gate for no reason.
      disabled={busy || state === 'approved'}
      onPress={onPress}
      style={({ pressed }) => [styles.doc, pressed && styles.pressed]}
    >
      <StatusDot tone={state === 'approved' ? 'primary' : state ? 'warn' : 'muted'} />
      <View style={styles.docText}>
        <Text variant="smallMedium" tone="onDark">
          {doc.label}
        </Text>
        <Text variant="tiny" tone="onDarkFaint">
          {latest?.status === 'rejected' && latest.rejection_reason
            ? latest.rejection_reason
            : doc.hint}
        </Text>
      </View>
      <Text
        variant="tiny"
        tone={tone === 'primary' ? 'primary' : tone === 'accent' ? 'accent' : 'onDarkMuted'}
      >
        {action}
      </Text>
    </Pressable>
  );
}

/** Step 3 — where settlements are sent, and what is taken on the way. */
function Payout(): React.ReactElement {
  const account = usePayoutAccount();
  const destinations = usePayoutDestinations();
  const resolve = useResolvePayoutAccount();
  const set = useSetPayoutAccount();
  const profile = useMerchantProfile();

  const [bankCode, setBankCode] = useState('');
  const [number, setNumber] = useState('');
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mdrBps = profile.data?.default_mdr_bps ?? 0;
  const reserveBps = profile.data?.default_reserve_bps ?? 0;
  // A worked example on a round number, because basis points are not how a
  // seller thinks about a sale. GHS 100 is the whole point: the arithmetic is
  // legible without doing any.
  const example = 10_000;
  const exampleMdr = Math.floor((example * mdrBps) / 10_000);
  const exampleReserve = Math.floor((example * reserveBps) / 10_000);

  async function check(): Promise<void> {
    setError(null);
    setConfirmed(null);
    try {
      const resolved = await resolve.mutateAsync({ bank_code: bankCode, account_number: number });
      setConfirmed(resolved.account_name);
    } catch (err) {
      setError(apiErrorMessage(err, 'That account could not be checked.'));
    }
  }

  const wallets = (destinations.data ?? []).filter((d) => d.kind === 'mobile_money');
  const banks = (destinations.data ?? []).filter((d) => d.kind === 'bank');

  return (
    <View style={styles.step}>
      {account.data?.connected ? (
        <Card dark style={styles.gap}>
          <Text variant="eyebrow" tone="onDarkFaint">
            PAYOUT DESTINATION
          </Text>
          <Text variant="h3" tone="onDark">
            {account.data.account_name ?? 'Connected'}
          </Text>
          <Text variant="tiny" tone="onDarkMuted">
            {/* Masked by the API — it never returns a full account number, not
                even to the merchant it belongs to. */}
            {account.data.account_number_masked ?? 'On file with Ejua'}
          </Text>
        </Card>
      ) : (
        <>
          <Text variant="small" tone="onDarkMuted" style={styles.blurb}>
            Every settlement goes here. The name is read back from the bank, never typed — so check
            it before you save.
          </Text>

          <View>
            <Text variant="eyebrow" tone="onDarkFaint">
              MOBILE MONEY
            </Text>
            <Destinations list={wallets} value={bankCode} onChange={setBankCode} />
          </View>
          <View>
            <Text variant="eyebrow" tone="onDarkFaint">
              OR A BANK
            </Text>
            <Destinations list={banks} value={bankCode} onChange={setBankCode} />
          </View>

          <Field
            dark
            label="NUMBER"
            value={number}
            onChangeText={(v) => {
              setNumber(v);
              setConfirmed(null);
            }}
            placeholder="024 551 3388"
            keyboardType="number-pad"
          />

          {confirmed ? (
            <Note eyebrow="The bank says" tone="primary">
              {`${confirmed}. If that is not you, check the number before saving.`}
            </Note>
          ) : null}
          {error ? (
            <Text variant="tiny" tone="accent">
              {error}
            </Text>
          ) : null}

          {confirmed ? (
            <Button
              label={set.isPending ? 'Saving…' : `Pay me here`}
              disabled={set.isPending}
              onPress={() =>
                set.mutate(
                  { bank_code: bankCode, account_number: number },
                  { onError: (err) => setError(apiErrorMessage(err, 'Could not save that.')) },
                )
              }
            />
          ) : (
            <Button
              label={resolve.isPending ? 'Checking…' : 'Check this account'}
              variant="outline"
              disabled={!bankCode || number.trim().length < 5 || resolve.isPending}
              onPress={() => void check()}
            />
          )}
        </>
      )}

      <Card dark style={styles.gap}>
        <Text variant="eyebrow" tone="onDarkFaint">
          HOW A GHS 100 SALE IS SPLIT
        </Text>
        <Line label="Order total" value={ghs(example)} dark />
        <Line
          label="Ejua fee"
          qualifier={`${mdrBps / 100}%`}
          value={`−${ghs(exampleMdr)}`}
          deduction
          dark
        />
        <Line
          label="Reserve held"
          qualifier={`${reserveBps / 100}%`}
          value={`−${ghs(exampleReserve)}`}
          deduction
          dark
        />
        <Total label="Paid to you" value={ghs(example - exampleMdr - exampleReserve)} dark />
        <Text variant="tiny" tone="onDarkFaint" style={styles.lead}>
          {/* The reserve is only taken on instalment sales, and released on the
              buffer for this merchant's model rather than a fixed number of
              days — which is why no day count is named here. */}
          The reserve is only held on instalment sales, and comes back to you once that buyer has
          finished paying. On a paid-in-full order there is no reserve at all.
        </Text>
      </Card>

      {profile.data && profile.data.min_payout_pesewas > 0 ? (
        <Note eyebrow="One thing to know">
          {/* A run below the floor writes no row at all — the seller sees no
              payout rather than a payout of zero, which is worth saying once
              here rather than leaving them to discover it. */}
          {`Payouts run nightly, but only once you are owed at least ${ghs(profile.data.min_payout_pesewas)}. Below that nothing is sent and the balance rolls into the next run.`}
        </Note>
      ) : null}
    </View>
  );
}

function Destinations({
  list,
  value,
  onChange,
}: {
  list: PayoutDestination[];
  value: string;
  onChange: (code: string) => void;
}): React.ReactElement {
  if (list.length === 0) {
    return (
      <Text variant="tiny" tone="onDarkFaint" style={styles.lead}>
        None available.
      </Text>
    );
  }
  return (
    <View style={styles.chips}>
      {list.map((d) => {
        const on = d.code === value;
        return (
          <Pressable
            key={d.code}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(d.code)}
            style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
          >
            <Text variant="tiny" tone={on ? 'onDark' : 'onDarkMuted'}>
              {d.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  title: { marginTop: space.sm },
  bars: { flexDirection: 'row', gap: 5, marginTop: space.lg },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  barOn: { backgroundColor: color.primary },
  barOff: { backgroundColor: color.darkLine },

  step: { gap: space.lg },
  gap: { gap: space.sm },
  blurb: { lineHeight: 20 },
  lead: { marginTop: space.sm, lineHeight: 16 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipOn: { backgroundColor: color.primary, borderColor: color.primary },
  chipOff: { backgroundColor: color.darkRaised, borderColor: color.darkBorder },

  doc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.darkRaised,
    borderWidth: 1,
    borderColor: color.darkBorder,
    borderRadius: radius.md,
    padding: space.lg,
  },
  docText: { flex: 1 },
  pressed: { opacity: 0.75 },

  back: { alignItems: 'center', paddingTop: space.md, paddingBottom: 2 },
});
