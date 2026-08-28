import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  Header,
  Icon,
  Loading,
  Screen,
  SectionLabel,
  Sheet,
  Text,
} from '../src/components';
import { useCredit, useInstallments, useProfile, useSetMomo } from '../src/features/account';
import { ghs, phoneDisplay, phoneE164 } from '../src/lib/format';
import { dateTime } from '../src/lib/dates';
import { color, radius, space } from '../src/theme/tokens';
import type { MomoProvider } from '../src/features/types';

/** The engine's telco codes, and what a Ghanaian shopper calls them. */
const NETWORKS: { code: MomoProvider; label: string }[] = [
  { code: 'mtn', label: 'MTN MoMo' },
  { code: 'vod', label: 'Telecel Cash' },
  { code: 'tgo', label: 'AT Money' },
];

/**
 * Wallet & payments.
 *
 * This screen deliberately departs from the design, which leads with an
 * available balance and Top up / Withdraw buttons. We did not build stored
 * value: holding customer funds in Ghana is e-money under the Bank of Ghana's
 * Payment Systems and Services Act — a licensing question, not an engineering
 * one — and the double-entry ledger has no customer liability account to hold
 * it. Everything here is real: the credit limit, the repayment record, the MoMo
 * instrument instalments collect from, and the payments actually made.
 */
export default function WalletScreen(): React.ReactElement {
  const credit = useCredit();
  const profile = useProfile();
  const history = useInstallments('paid');
  const [sheetOpen, setSheetOpen] = useState(false);

  if (credit.isPending || profile.isPending) {
    return (
      <Screen>
        <Header title="Wallet & payments" back />
        <Loading />
      </Screen>
    );
  }

  if (credit.isError || !credit.data) {
    return (
      <Screen>
        <Header title="Wallet & payments" back />
        <ErrorState
          message="We couldn't load your account."
          onRetry={() => void credit.refetch()}
        />
      </Screen>
    );
  }

  const c = credit.data;
  const me = profile.data;
  const network = me?.momo_provider
    ? NETWORKS.find((n) => n.code === me.momo_provider)?.label
    : null;

  const usedFraction =
    c.approved_limit_pesewas > 0 ? Math.min(1, c.in_use_pesewas / c.approved_limit_pesewas) : 0;

  return (
    <>
      <Screen refreshing={credit.isRefetching} onRefresh={() => void credit.refetch()}>
        <Header title="Wallet & payments" back />

        <View style={styles.body}>
          {c.has_limit ? (
            <Card dark style={styles.limit}>
              <Text variant="eyebrow" tone="onDarkFaint">
                EJUA LIMIT
              </Text>
              <Text variant="display" tone="onDark" style={styles.limitAmount}>
                {ghs(c.approved_limit_pesewas)}
              </Text>
              <View style={styles.bar}>
                <View style={[styles.barFill, { flex: usedFraction }]} />
                <View style={{ flex: 1 - usedFraction }} />
              </View>
              <Text variant="small" tone="onDarkMuted">
                {ghs(c.in_use_pesewas)} in use · {ghs(c.available_pesewas)} available
              </Text>
            </Card>
          ) : (
            <Card dark style={styles.limit}>
              <Text variant="eyebrow" tone="onDarkFaint">
                EJUA LIMIT
              </Text>
              <Text variant="h2" tone="onDark">
                Not set yet
              </Text>
              <Text variant="small" tone="onDarkMuted">
                Your limit is worked out the first time you choose to pay in instalments at
                checkout. You will see the decision before anything is charged.
              </Text>
            </Card>
          )}

          <Card style={styles.record}>
            <View style={styles.recordText}>
              <Text variant="eyebrow" tone="faint">
                ON TIME
              </Text>
              {c.total_payments > 0 ? (
                <>
                  <Text variant="h2">
                    {c.on_time_payments} / {c.total_payments}
                  </Text>
                  <Text variant="tiny" tone="muted">
                    {c.late_payments > 0
                      ? `${c.late_payments} paid late. `
                      : 'Every payment on time. '}
                    A good record is what raises your limit.
                  </Text>
                </>
              ) : (
                <>
                  <Text variant="h2">No payments yet</Text>
                  <Text variant="tiny" tone="muted">
                    Paying on time is what raises your limit.
                  </Text>
                </>
              )}
            </View>
          </Card>

          <SectionLabel style={styles.sectionGap}>Payment method</SectionLabel>
          <Card style={styles.method}>
            <View style={styles.methodIcon}>
              <Icon name="phone" size={17} color={color.ink} />
            </View>
            <View style={styles.methodText}>
              {me?.momo_phone ? (
                <>
                  <Text variant="smallMedium">{network ?? 'Mobile Money'}</Text>
                  <Text variant="tiny" tone="muted">
                    {phoneDisplay(me.momo_phone)} · instalments collect from here
                  </Text>
                </>
              ) : (
                <>
                  <Text variant="smallMedium">No Mobile Money number set</Text>
                  <Text variant="tiny" tone="muted">
                    Add one so instalments can be collected without you having to pay by hand.
                  </Text>
                </>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                me?.momo_phone ? 'Change your Mobile Money number' : 'Add a Mobile Money number'
              }
              onPress={() => setSheetOpen(true)}
              hitSlop={8}
            >
              <Text variant="smallMedium" tone="accent">
                {me?.momo_phone ? 'Change' : 'Add'}
              </Text>
            </Pressable>
          </Card>

          <SectionLabel style={styles.sectionGap}>Recent activity</SectionLabel>
          {history.isPending ? <Loading /> : null}
          {history.data && history.data.length === 0 ? (
            <Card>
              <Text variant="small" tone="muted">
                Nothing yet. Payments you make will be listed here.
              </Text>
            </Card>
          ) : null}
          {history.data && history.data.length > 0 ? (
            <Card bare>
              {history.data.map((row, index) => (
                <View key={row.id} style={[styles.activity, index > 0 && styles.activityDivider]}>
                  <View style={styles.activityIcon}>
                    <Text variant="smallMedium" tone="accent">
                      −
                    </Text>
                  </View>
                  <View style={styles.activityText}>
                    <Text variant="smallMedium" numberOfLines={1}>
                      {row.item_title ?? 'Instalment'} · {row.position} of {row.total_installments}
                    </Text>
                    <Text variant="tiny" tone="muted">
                      {dateTime(row.paid_at)}
                    </Text>
                  </View>
                  <Text variant="smallMedium">−{ghs(row.amount_paid_pesewas)}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {/* Saying this plainly beats an unexplained absence where the design
              promised a balance. */}
          <Text variant="tiny" tone="faint" style={styles.footnote}>
            Ejua does not hold a cash balance for you. Every payment comes straight from your Mobile
            Money at the moment it is due, and refunds go back the same way.
          </Text>
        </View>
      </Screen>

      <MomoSheet
        visible={sheetOpen}
        initialPhone={me?.momo_phone ?? ''}
        initialNetwork={me?.momo_provider ?? 'mtn'}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

function MomoSheet({
  visible,
  initialPhone,
  initialNetwork,
  onClose,
}: {
  visible: boolean;
  initialPhone: string;
  initialNetwork: MomoProvider;
  onClose: () => void;
}): React.ReactElement {
  const setMomo = useSetMomo();
  const [phone, setPhone] = useState(initialPhone);
  const [network, setNetwork] = useState<MomoProvider>(initialNetwork);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setError(null);
    try {
      await setMomo.mutateAsync({ momo_phone: phoneE164(phone), momo_provider: network });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not save that number.'));
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="h3" style={styles.sheetTitle}>
        Mobile Money
      </Text>
      <Text variant="small" tone="muted" style={styles.sheetBody}>
        This is the number instalments are collected from, and where refunds are sent.
      </Text>

      <Text variant="eyebrow" tone="faint" style={styles.fieldLabel}>
        NETWORK
      </Text>
      <View style={styles.networks}>
        {NETWORKS.map((n) => (
          <Chip
            key={n.code}
            label={n.label}
            selected={network === n.code}
            onPress={() => setNetwork(n.code)}
          />
        ))}
      </View>

      <Text variant="eyebrow" tone="faint" style={styles.fieldLabel}>
        NUMBER
      </Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        placeholder="024 000 0000"
        placeholderTextColor={color.mutedSoft}
        keyboardType="phone-pad"
        accessibilityLabel="Your Mobile Money number"
        style={styles.input}
      />

      {error ? (
        <Text variant="small" tone="accent" style={styles.sheetError}>
          {error}
        </Text>
      ) : null}

      <Button
        label="Save"
        loading={setMomo.isPending}
        disabled={phone.replace(/\D/g, '').length < 9}
        onPress={() => void save()}
        style={styles.sheetCta}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  limit: { gap: 6 },
  limitAmount: { marginVertical: 2 },
  bar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.darkHover,
    overflow: 'hidden',
    marginVertical: space.sm,
  },
  barFill: { backgroundColor: color.accent },
  record: { flexDirection: 'row' },
  recordText: { flex: 1, gap: 2 },
  sectionGap: { marginTop: space.md, marginBottom: 0 },
  method: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  methodIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodText: { flex: 1, gap: 2 },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  activityDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  activityIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityText: { flex: 1, gap: 1 },
  footnote: { marginTop: space.sm, paddingHorizontal: 2 },
  sheetTitle: { marginBottom: 4 },
  sheetBody: { marginBottom: space.lg },
  fieldLabel: { marginBottom: space.sm },
  networks: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  input: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.sm,
    height: 50,
    paddingHorizontal: space.md,
    fontFamily: 'Outfit_400Regular',
    fontSize: 16,
    color: color.ink,
  },
  sheetError: { marginTop: space.sm },
  sheetCta: { marginTop: space.lg, marginBottom: space.md },
});
