import React from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Icon,
  Loading,
  Pill,
  Screen,
  SectionLabel,
  Text,
} from '../../src/components';
import { useProfile } from '../../src/features/account';
import { usePendingReviews } from '../../src/features/reviews';
import { useAddresses, useOrders } from '../../src/features/shop';
import { initials, phoneDisplay, pluralise } from '../../src/lib/format';
import { deregisterThisHandset } from '../../src/lib/push';
import { color, radius, space } from '../../src/theme/tokens';

/** The engine's telco codes, and what a Ghanaian shopper calls them. */
const NETWORK_LABEL: Record<string, string> = {
  mtn: 'MTN MoMo',
  vod: 'Telecel Cash',
  tgo: 'AT Money',
};

export default function AccountScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { signedIn, signOut, api } = useAuth();
  const profile = useProfile(signedIn);
  const orders = useOrders(signedIn);
  const addresses = useAddresses(signedIn);
  const pendingReviews = usePendingReviews(signedIn);

  if (!signedIn) {
    return (
      <Screen tabBar dark>
        <View style={[styles.signedOut, { paddingTop: insets.top + space.xxxl }]}>
          <Text variant="h1" tone="onDark">
            ejua
          </Text>
          <Text variant="body" tone="onDarkMuted" style={styles.signedOutBody}>
            Sign in to check out, follow your deliveries and manage what you owe.
          </Text>
          <View style={styles.trust}>
            {['Escrow protected', 'MoMo checkout', 'Real schedule up front'].map((t) => (
              <View key={t} style={styles.trustChip}>
                <Icon name="check" size={11} color={color.success} strokeWidth={3} />
                <Text variant="tiny" tone="onDarkMuted">
                  {t}
                </Text>
              </View>
            ))}
          </View>
          <Button
            label="Sign in or create an account"
            style={styles.signedOutCta}
            onPress={() => router.push('/onboarding')}
          />
        </View>
      </Screen>
    );
  }

  if (profile.isPending) {
    return (
      <Screen tabBar>
        <Loading />
      </Screen>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <Screen tabBar>
        <ErrorState
          message="We couldn't load your account."
          onRetry={() => void profile.refetch()}
        />
      </Screen>
    );
  }

  const me = profile.data;
  const defaultAddress = addresses.data?.find((a) => a.is_default) ?? addresses.data?.[0];
  const network = me.momo_provider ? NETWORK_LABEL[me.momo_provider] : null;

  // Deregistering has to happen BEFORE the session is cleared: the route is
  // authenticated. It never throws, so a bad connection cannot strand somebody
  // in a half-signed-out state.
  async function handleSignOut(): Promise<void> {
    await deregisterThisHandset(api);
    await signOut();
  }

  function confirmSignOut(): void {
    Alert.alert('Sign out?', 'You will need your phone number and a code to sign back in.', [
      { text: 'Stay signed in', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void handleSignOut() },
    ]);
  }

  return (
    <Screen tabBar refreshing={profile.isRefetching} onRefresh={() => void profile.refetch()}>
      <View style={[styles.header, { paddingTop: insets.top + space.xl }]}>
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Text variant="h3" tone="onDark">
              {initials(`${me.first_name} ${me.last_name}`)}
            </Text>
          </View>
          <View style={styles.identityText}>
            <Text variant="h2" tone="onDark" numberOfLines={1}>
              {me.first_name} {me.last_name}
            </Text>
            <Text variant="small" tone="onDarkMuted" numberOfLines={1}>
              {phoneDisplay(me.phone)}
              {defaultAddress ? ` · ${defaultAddress.city}` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.stats}>
          <StatTile
            value={String(me.counts.saved_items)}
            label="Saved"
            onPress={() => router.push('/browse')}
          />
          <StatTile
            value={String(me.counts.active_plans)}
            label="Instalments"
            onPress={() => router.push('/plans')}
          />
          <StatTile
            value={orders.data ? String(orders.data.length) : '—'}
            label="Orders"
            onPress={() => router.push('/orders')}
          />
        </View>
      </View>

      <View style={styles.body}>
        {!me.ghana_card_verified ? (
          <Pressable onPress={() => router.push('/ghana-card')}>
            <Card style={styles.kyc}>
              <View style={styles.kycHead}>
                <Icon name="shield" size={18} color={color.warn} />
                <Text variant="smallMedium">Verify your Ghana Card</Text>
                <Icon name="chevron-right" size={16} color={color.muted} />
              </View>
              {/* This card carried a "COMING SOON" pill from the day the app
                  shipped, and it was accurate: `attachGhanaCard` had one caller
                  and it was the admin console, so there was nowhere for a
                  shopper to send a card. Now there is. */}
              <Text variant="tiny" tone="muted">
                A verified card raises the limit you can spread across instalments. It takes a photo
                and about a minute.
              </Text>
            </Card>
          </Pressable>
        ) : null}

        <Card bare>
          <MenuRow
            label="My instalments"
            hint={
              me.counts.active_plans > 0
                ? `${pluralise(me.counts.active_plans, 'plan')} active`
                : 'None active'
            }
            onPress={() => router.push('/plans')}
          />
          <MenuRow
            label="Wallet & payments"
            hint={network ?? 'Not set'}
            onPress={() => router.push('/wallet')}
          />
          {/* Was one row labelled "Orders & returns" that went to the orders
              tab and nowhere near a return — the label promised a destination
              that did not exist. Two rows now, each going where it says. */}
          <MenuRow label="Orders" onPress={() => router.push('/orders')} />
          <MenuRow label="Returns" onPress={() => router.push('/returns')} />
          <MenuRow
            label="Rate what you bought"
            hint={pendingReviews.data?.length ? String(pendingReviews.data.length) : undefined}
            onPress={() => router.push('/reviews')}
          />
          <MenuRow
            label="Saved items"
            hint={String(me.counts.saved_items)}
            onPress={() => router.push('/browse')}
          />
          <MenuRow
            label="Delivery addresses"
            hint={defaultAddress ? defaultAddress.city : 'None saved'}
            onPress={() => router.push('/checkout')}
          />
          {/* Inert rather than a button that goes nowhere: neither destination
              exists yet, and a dead tap is worse than a plain row. */}
          <MenuRow label="Help & support" hint="Coming soon" />
          <MenuRow label="Language & currency" hint="English · GHS" last />
        </Card>

        <Card style={styles.sell}>
          <Text variant="smallMedium">Sell on Ejua</Text>
          <Text variant="tiny" tone="muted" style={styles.sellBody}>
            A seller app is on the way. It will let you list a product, take orders and get settled
            from your phone.
          </Text>
        </Card>

        <SectionLabel style={styles.consentHead}>Your consents</SectionLabel>
        <Card style={styles.consents}>
          <ConsentRow label="How we use your data" at={me.consents.data_processing_at} />
          <ConsentRow label="Credit checks" at={me.consents.credit_scoring_at} />
          <ConsentRow label="Offers and deals" at={me.consents.marketing_at} optional />
        </Card>

        <Button label="Sign out" variant="danger" onPress={confirmSignOut} />

        <Text variant="tiny" tone="faint" center style={styles.version}>
          Ejua v1.0 · Nesisoft · Accra
        </Text>
      </View>
    </Screen>
  );
}

function StatTile({
  value,
  label,
  onPress,
}: {
  value: string;
  label: string;
  onPress?: () => void;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${label}: ${value}` : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.stat, { opacity: pressed && onPress ? 0.7 : 1 }]}
    >
      <Text variant="h3" tone="onDark">
        {value}
      </Text>
      <Text variant="tiny" tone="onDarkFaint">
        {label}
      </Text>
    </Pressable>
  );
}

function MenuRow({
  label,
  hint,
  onPress,
  last,
}: {
  label: string;
  hint?: string;
  onPress?: () => void;
  last?: boolean;
}): React.ReactElement {
  const content = (
    <View style={[styles.menuRow, !last && styles.menuDivider]}>
      <Text variant="body" tone={onPress ? 'ink' : 'muted'} style={styles.menuLabel}>
        {label}
      </Text>
      {hint ? (
        <Text variant="small" tone="faint">
          {hint}
        </Text>
      ) : null}
      {onPress ? <Icon name="chevron-right" size={16} color={color.borderStrong} /> : null}
    </View>
  );

  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {content}
    </Pressable>
  );
}

/**
 * Consents as timestamps, not ticks.
 *
 * "When did I agree to a credit check" is the question a customer — and a
 * regulator — actually asks, and a checkbox cannot answer it.
 */
function ConsentRow({
  label,
  at,
  optional,
}: {
  label: string;
  at: string | null;
  optional?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.consentRow}>
      <Text variant="small" tone="muted" style={styles.menuLabel}>
        {label}
      </Text>
      <Pill
        label={at ? 'AGREED' : optional ? 'NOT OPTED IN' : 'REQUIRED'}
        tone={at ? 'success' : 'neutral'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  signedOut: { flex: 1, paddingHorizontal: space.xxl, gap: space.lg },
  signedOutBody: { maxWidth: 300 },
  signedOutCta: { marginTop: space.lg },
  trust: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  trustChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.darkRaised,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  header: {
    backgroundColor: color.dark,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    gap: space.xl,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: color.darkHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityText: { flex: 1, gap: 2 },
  stats: { flexDirection: 'row', gap: space.sm },
  stat: {
    flex: 1,
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    gap: 2,
  },
  body: { padding: space.lg, gap: space.md },
  kyc: { gap: space.sm },
  kycHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 15,
  },
  menuDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  menuLabel: { flex: 1 },
  sell: { gap: 4 },
  sellBody: { marginTop: 2 },
  consentHead: { marginTop: space.sm, marginBottom: 0 },
  consents: { gap: space.md },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  version: { marginTop: space.md },
});
