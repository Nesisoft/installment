import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, useAuth } from '@installment/mobile-kit';
import { GHANA_REGIONS, type GhanaRegion, type StoreStatus } from '@installment/api-types';
import {
  Avatar,
  Button,
  Card,
  ErrorState,
  Field,
  Icon,
  Loading,
  Note,
  Pill,
  Screen,
  SectionLabel,
  Text,
  type PillTone,
} from '../../src/components';
import {
  isNoStoreYet,
  useCatalogSummary,
  useKycStatus,
  useMerchantProfile,
  useMerchantStats,
  useMerchantStore,
  usePayoutAccount,
  usePlanCounts,
  useReturnCounts,
  useUpdateMerchantStore,
} from '../../src/features/merchant';
import { feeSentence } from '../../src/lib/fees';
import { compact, initials, pluralise } from '../../src/lib/format';
import { deregisterThisHandset } from '../../src/lib/push';
import { color, font, radius, space } from '../../src/theme/tokens';

const STATUS: Record<StoreStatus, { label: string; tone: PillTone }> = {
  draft: { label: 'Not live yet', tone: 'warn' },
  active: { label: 'Live', tone: 'primary' },
  suspended: { label: 'Suspended', tone: 'accent' },
};

/**
 * The shop: what a buyer sees, and everything behind it.
 *
 * Three things on the canvas are not on this screen, each for the same reason —
 * the control would change nothing:
 *
 *   - **Reply time.** There is no messaging anywhere in this system: no thread
 *     table, no send route, nothing a seller could reply on. A "6h reply time"
 *     tile would be a number with no source.
 *   - **Shop accent.** Nothing stores one. `stores.metadata` would take it, but
 *     `StorefrontStore` never returns metadata, so a seller could pick a colour
 *     and no buyer would ever see it.
 *   - **On-time percentage.** It exists, but only on the *public* storefront
 *     view, which refuses a shop that is not yet active — so the shops that
 *     most want the number are exactly the ones that cannot read it.
 *
 * What replaces them is what the seller's own surface actually serves, and the
 * market editor this slice's schema change unlocked.
 */
export default function ShopTab(): React.ReactElement {
  const { signOut, api } = useAuth();
  const queryClient = useQueryClient();
  const store = useMerchantStore();
  const profile = useMerchantProfile();

  const refresh = useCallback(() => {
    void store.refetch();
    void profile.refetch();
  }, [store, profile]);

  // Signing out clears the cache with the session: every screen in this app is
  // one shop's money, and the next account on this handset must not see it.
  //
  // Push comes off first, while the session can still authenticate the call —
  // otherwise this handset keeps buzzing for a shop nobody is signed into.
  async function handleSignOut(): Promise<void> {
    await deregisterThisHandset(api);
    await signOut();
    queryClient.clear();
  }

  if (store.isPending) {
    return (
      <Screen tabBar>
        <Loading />
      </Screen>
    );
  }

  if (store.error && isNoStoreYet(store.error)) {
    return (
      <Screen tabBar>
        <View style={styles.body}>
          <SectionLabel>Your shop</SectionLabel>
          <Card style={styles.gap}>
            <Text variant="h2">There is no shop on this account yet</Text>
            <Text variant="small" tone="muted">
              Signing up creates one, so this almost always means the account was made for you
              before the shopfront was. Ejua support can add it — nothing you have sold is affected.
            </Text>
            <Button label="Sign out" variant="outline" onPress={() => void handleSignOut()} />
          </Card>
        </View>
      </Screen>
    );
  }

  if (store.error || !store.data) {
    return (
      <Screen tabBar>
        <ErrorState
          message={apiErrorMessage(store.error, 'Could not load your shop.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  return (
    <Screen tabBar refreshing={store.isFetching} onRefresh={refresh}>
      <ShopHeader />
      <View style={styles.body}>
        <Storefront />
        <Settings />
        <Card style={styles.gap}>
          <Text variant="smallMedium">Flyers and paid ads</Text>
          <Text variant="tiny" tone="faint" style={styles.lead}>
            Turning a listing into a flyer or an advert is a separate part of Ejua. This app is your
            catalogue, your orders and your money.
          </Text>
        </Card>
        <Button label="Sign out" variant="outline" onPress={() => void handleSignOut()} />
        <Text variant="tiny" tone="faint" center style={styles.footer}>
          Ejua Sell · Nesisoft
        </Text>
      </View>
    </Screen>
  );
}

/** The dark panel: who the shop is, and three figures worth a tap. */
function ShopHeader(): React.ReactElement | null {
  const store = useMerchantStore();
  const catalogue = useCatalogSummary();
  const stats = useMerchantStats(30);
  const plans = usePlanCounts();

  const s = store.data;
  if (!s) return null;
  const status = STATUS[s.status];
  const where = [s.city, s.region].filter(Boolean).join(', ');

  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <Avatar
          initials={initials(s.display_name)}
          size={54}
          background={color.primary}
          foreground={color.onDark}
        />
        <View style={styles.heroText}>
          <Text variant="h2" tone="onDark" numberOfLines={1}>
            {s.display_name}
          </Text>
          <Text variant="tiny" tone="onDarkMuted" numberOfLines={1}>
            {/* The public address, which is fixed. A seller who has shared it on
                a flyer needs to be able to read it back exactly. */}
            {`ejua.shop/${s.slug}${where ? ` · ${where}` : ''}`}
          </Text>
        </View>
        <Pill label={status.label} tone={status.tone} />
      </View>

      <View style={styles.tiles}>
        <HeroTile
          label="Live products"
          value={catalogue.data ? String(catalogue.data.liveProducts) : '—'}
          sub={
            catalogue.data
              ? `of ${pluralise(catalogue.data.products, 'listing')}`
              : 'Counting your stock'
          }
          onPress={() => router.push('/products')}
        />
        <HeroTile
          label="Orders · 30d"
          value={stats.data ? compact(stats.data.current.orders) : '—'}
          sub={stats.data ? `${compact(stats.data.current.cancelledOrders)} cancelled` : 'Loading'}
          onPress={() => router.push('/performance')}
        />
        <HeroTile
          label="Plans running"
          value={plans.data ? String(plans.data.active) : '—'}
          sub={plans.data && plans.data.late > 0 ? `${plans.data.late} behind` : 'None behind'}
          onPress={() => router.push('/plans')}
        />
      </View>
    </View>
  );
}

function HeroTile({
  label,
  value,
  sub,
  onPress,
}: {
  label: string;
  value: string;
  sub: string;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. ${sub}`}
      onPress={onPress}
      style={({ pressed }) => [styles.heroTile, pressed && styles.pressed]}
    >
      <Text variant="h3" tone="onDark">
        {value}
      </Text>
      <Text variant="tiny" tone="onDarkMuted" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="tiny" tone="onDarkFaint" numberOfLines={1} style={styles.tileSub}>
        {sub}
      </Text>
    </Pressable>
  );
}

/**
 * The two things about the shopfront a seller may change from here.
 *
 * `about` and the market, and nothing else. The name, the artwork and the
 * category are shop *setup* and live on that screen; the slug is the public URL
 * and is deliberately not editable at all — renaming it breaks every link
 * already shared and every QR code already printed.
 */
function Storefront(): React.ReactElement | null {
  const store = useMerchantStore();
  const update = useUpdateMerchantStore();
  const s = store.data;

  const [about, setAbout] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState<GhanaRegion | ''>('');

  const savedAbout = s?.about ?? '';
  const savedCity = s?.city ?? '';
  const savedRegion = (s?.region ?? '') as GhanaRegion | '';

  // Re-seeded from the server's copy, so a save that normalised something (a
  // trimmed tagline) leaves the form agreeing with the shopfront rather than
  // showing what was typed.
  //
  // The dependencies are the three VALUES, never the query result. React Query
  // hands back a new object on every background refetch, and depending on it
  // would wipe whatever the seller was halfway through typing the moment the
  // screen refocused.
  useEffect(() => {
    setAbout(savedAbout);
    setCity(savedCity);
    setRegion(savedRegion);
  }, [savedAbout, savedCity, savedRegion]);

  const dirty = useMemo(
    () => about !== savedAbout || city !== savedCity || region !== savedRegion,
    [about, city, region, savedAbout, savedCity, savedRegion],
  );

  if (!s) return null;

  function save(): void {
    update.mutate({
      about: about.trim(),
      // `null`, not `undefined`: an emptied field has to clear the column.
      // `undefined` would leave the old value standing and the form would
      // silently disagree with the shopfront a buyer is reading.
      city: city.trim() || null,
      region: region || null,
    });
  }

  return (
    <View>
      <SectionLabel>Your shopfront</SectionLabel>
      <Card style={styles.gap}>
        <Field
          label="TAGLINE"
          value={about}
          onChangeText={setAbout}
          placeholder="Hand-finished wax print, sewn in Makola."
          multiline
          maxLength={5000}
          hint="Shown under your shop name on your storefront."
          style={styles.multiline}
        />

        <Field
          label="TOWN OR MARKET"
          value={city}
          onChangeText={setCity}
          placeholder="Makola, Accra"
          maxLength={120}
        />

        <View>
          <Text variant="eyebrow" tone="faint">
            REGION
          </Text>
          <View style={styles.regions}>
            {GHANA_REGIONS.map((r) => {
              const on = r === region;
              return (
                <Pressable
                  key={r}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  // Tapping the chosen region again clears it: there is no
                  // "none" chip, and a seller who picked the wrong one needs a
                  // way back to unset without picking another wrong one.
                  onPress={() => setRegion(on ? '' : r)}
                  style={[styles.region, on ? styles.regionOn : styles.regionOff]}
                >
                  <Text
                    variant="tiny"
                    style={{ color: on ? color.onDark : color.inkSoft }}
                    numberOfLines={1}
                  >
                    {r}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text variant="tiny" tone="faint" style={styles.lead}>
            {/* Not cosmetic: this is the only thing on a storefront that tells a
                buyer whether the seller is down the road or across the country. */}
            Buyers see this on your shopfront. Leave it off and your shop shows no location at all.
          </Text>
        </View>

        {update.isError ? (
          <Text variant="tiny" tone="accent">
            {apiErrorMessage(update.error, 'Could not save that.')}
          </Text>
        ) : null}

        <Button
          label={update.isPending ? 'Saving…' : 'Save shopfront'}
          disabled={!dirty || update.isPending}
          onPress={save}
        />
      </Card>
    </View>
  );
}

/** Everything else about the shop, and where each of them really lives. */
function Settings(): React.ReactElement {
  const store = useMerchantStore();
  const kyc = useKycStatus();
  const payout = usePayoutAccount();
  const plans = usePlanCounts();
  const returns = useReturnCounts();
  const profile = useMerchantProfile();

  const draft = store.data?.status !== 'active';
  const kycHint = kyc.data
    ? kyc.data.complete || kyc.data.exempt
      ? 'Verified'
      : `${pluralise(kyc.data.outstanding.length, 'document')} outstanding`
    : '—';

  return (
    <View>
      <SectionLabel>Your shop</SectionLabel>
      <Card bare style={styles.rows}>
        {draft ? (
          <Row
            label="Finish setting up your shop"
            hint="Not live"
            tone="warn"
            onPress={() => router.push('/onboarding')}
          />
        ) : null}
        <Row
          label="Instalment plans"
          hint={plans.data ? `${plans.data.active} running` : '—'}
          onPress={() => router.push('/plans')}
        />
        <Row label="Performance" hint="Last 30 days" onPress={() => router.push('/performance')} />
        <Row
          label="Payout method"
          hint={payout.data?.connected ? (payout.data.account_name ?? 'Connected') : 'Not set'}
          tone={payout.data?.connected ? undefined : 'warn'}
          onPress={() => router.push('/payouts')}
        />
        <Row
          label="Verification & documents"
          hint={kycHint}
          tone={kyc.data && !kyc.data.complete && !kyc.data.exempt ? 'warn' : undefined}
          onPress={() => router.push('/onboarding')}
        />
        <Row
          label="Returns"
          hint={returns.data ? waitingHint(returns.data.requested) : 'Decided one by one'}
          tone={returns.data && returns.data.requested > 0 ? 'warn' : undefined}
          onPress={() => router.push('/returns')}
        />
        <Row label="Delivery fees" hint="Set by Ejua" />
        <Row
          label="Change password"
          hint="Signs out other devices"
          onPress={() => router.push('/change-password')}
        />
      </Card>

      <Note eyebrow="One of these is not yours to set">
        {/* A real limit of the platform today: `delivery_zones` has no
            merchant_id, so a settings row that opened an editor would be a
            control over nothing. */}
        {`Delivery is priced from one national rate card, the same for every shop — there is no per-shop table to edit. Returns are not a policy either: each request comes to you to accept or refuse, one at a time.${
          // `default_mdr_bps` printed a flat 4% that nothing charges: a
          // paid-in-full order takes the marketplace commission, and a plan
          // its own type's rate unless this seller has a deal. Optional
          // because an app build can reach an API that predates `fees`.
          profile.data?.fees ? ` ${feeSentence(profile.data.fees)}` : ''
        }`}
      </Note>
    </View>
  );
}

/** "2 waiting on you" is a call to action; "None waiting" is reassurance. */
function waitingHint(waiting: number): string {
  return waiting === 0 ? 'None waiting' : `${waiting} waiting on you`;
}

function Row({
  label,
  hint,
  tone,
  onPress,
}: {
  label: string;
  hint: string;
  tone?: 'warn';
  onPress?: () => void;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${label}. ${hint}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && onPress ? styles.pressed : null]}
    >
      <Text variant="bodyMedium" style={styles.rowLabel}>
        {label}
      </Text>
      <Text variant="tiny" tone={tone === 'warn' ? 'accent' : 'faint'} numberOfLines={1}>
        {hint}
      </Text>
      {onPress ? <Icon name="chevron-right" size={16} color={color.mutedSoft} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: color.dark, paddingHorizontal: space.lg, paddingBottom: space.xl },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingTop: space.xxxl + space.xl,
  },
  heroText: { flex: 1 },
  tiles: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  heroTile: {
    flex: 1,
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    padding: space.md,
    gap: 1,
  },
  tileSub: { marginTop: 1 },
  pressed: { opacity: 0.75 },

  body: { padding: space.lg, gap: space.xl },
  gap: { gap: space.lg },
  lead: { marginTop: space.xs, lineHeight: 16 },
  multiline: { minHeight: 78, textAlignVertical: 'top' },
  footer: { paddingTop: space.sm },

  regions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  region: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  regionOn: { backgroundColor: color.ink, borderColor: color.ink },
  regionOff: { backgroundColor: color.surface, borderColor: color.border },

  rows: { paddingHorizontal: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
  },
  rowLabel: { flex: 1, fontFamily: font.medium },
});
