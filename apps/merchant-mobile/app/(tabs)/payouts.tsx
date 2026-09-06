import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantHeldReserveRow, MerchantPayoutRow } from '@installment/api-types';
import {
  Card,
  ErrorState,
  Icon,
  Loading,
  Note,
  Pill,
  Screen,
  SectionLabel,
  Segmented,
  StatTile,
  StatusDot,
  Text,
  type SegmentOption,
} from '../../src/components';
import {
  useMerchantBalances,
  useMerchantProfile,
  usePayoutAccount,
  usePayouts,
  useReserves,
} from '../../src/features/merchant';
import { dateTime, shortDate } from '../../src/lib/dates';
import { cedis, ghs, pluralise } from '../../src/lib/format';
import { color, font, radius, space } from '../../src/theme/tokens';

type ReserveFilter = 'open' | 'released';

const RESERVE_CHIPS: SegmentOption<ReserveFilter>[] = [
  { value: 'open', label: 'Still held' },
  { value: 'released', label: 'Released' },
];

export default function PayoutsScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [reserveFilter, setReserveFilter] = useState<ReserveFilter>('open');

  const balances = useMerchantBalances();
  const profile = useMerchantProfile();
  const account = usePayoutAccount();
  const payouts = usePayouts();
  const reserves = useReserves(reserveFilter === 'open');

  const refresh = useCallback(() => {
    void balances.refetch();
    void account.refetch();
    void payouts.refetch();
    void reserves.refetch();
  }, [balances, account, payouts, reserves]);

  if (balances.isPending) {
    return (
      <Screen tabBar>
        <Loading />
      </Screen>
    );
  }

  if (balances.error) {
    return (
      <Screen tabBar>
        <ErrorState
          message={apiErrorMessage(balances.error, 'Could not load your payouts.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const payable = balances.data.payablePesewas;
  const floor = profile.data?.min_payout_pesewas;
  // The floor is a real column the settlement run reads, so this is not a guess
  // — but only once the profile has loaded, which is why it is not asserted
  // while `floor` is undefined.
  const belowFloor = floor !== undefined && payable > 0 && payable < floor;
  const destination = account.data?.connected
    ? [account.data.account_name, account.data.account_number_masked].filter(Boolean).join(' · ')
    : null;

  return (
    <Screen tabBar refreshing={payouts.isFetching || reserves.isFetching} onRefresh={refresh}>
      <View style={[styles.hero, { paddingTop: insets.top + space.lg }]}>
        <View style={styles.heroHead}>
          <Text variant="eyebrow" tone="onDarkFaint">
            {belowFloor ? 'ROLLING INTO THE NEXT RUN' : 'IN THE NEXT PAYOUT RUN'}
          </Text>
          <Pill label="AUTOMATIC" tone="primary" />
        </View>
        <Text variant="display" tone="onDark" style={styles.heroValue}>
          {ghs(payable)}
        </Text>
        <Text variant="small" tone="onDarkMuted">
          {destination
            ? `To ${destination}`
            : account.isPending
              ? ' '
              : 'No payout destination set up yet'}
        </Text>

        {/* The canvas says "tonight 11:00 pm". The settlement batch is a daily
            cron and nothing publishes its next run over HTTP, so naming a time
            here would be a promise this app cannot keep — and the one time the
            canvas names is not the one the server runs. */}
        <View style={styles.heroNote}>
          <Icon name="clock" size={15} color={color.onDarkMuted} />
          <Text variant="tiny" tone="onDarkMuted" style={styles.heroNoteText}>
            {floor === undefined
              ? 'Payouts run automatically — you never have to withdraw.'
              : `Payouts run automatically. Anything under ${ghs(floor)} rolls into the next run — no withdrawal needed.`}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.tiles}>
          <StatTile
            tone="primary"
            eyebrow="Payable now"
            value={ghs(payable)}
            sub={belowFloor ? 'Under the floor — rolls over' : 'Goes out automatically'}
          />
          <StatTile
            tone="warn"
            eyebrow="Reserve held"
            value={ghs(balances.data.reserveHeldPesewas)}
            sub={pluralise(balances.data.openReservesCount, 'open plan')}
          />
        </View>
        <View style={styles.tiles}>
          <StatTile
            tone="muted"
            eyebrow="Lifetime settled"
            value={ghs(balances.data.lifetimeSettledPesewas)}
            sub="Paid out to you so far"
          />
          <StatTile
            tone="info"
            eyebrow="Active plans"
            value={String(balances.data.activePlans)}
            sub="Ejua carries the risk"
          />
        </View>

        <View>
          <SectionLabel>Reserve</SectionLabel>
          <Segmented
            scroll={false}
            options={RESERVE_CHIPS}
            value={reserveFilter}
            onChange={setReserveFilter}
            style={styles.reserveChips}
          />
          {reserves.isPending ? (
            <Loading />
          ) : reserves.error ? (
            <Text variant="small" tone="muted">
              {apiErrorMessage(reserves.error, 'Could not load your reserve.')}
            </Text>
          ) : (reserves.data ?? []).length === 0 ? (
            <Card style={styles.blank}>
              <Text variant="smallMedium">
                {reserveFilter === 'open' ? 'Nothing held back' : 'Nothing released yet'}
              </Text>
              <Text variant="tiny" tone="faint" style={styles.blankSub}>
                {reserveFilter === 'open'
                  ? 'Reserve is only withheld on instalment sales.'
                  : 'Reserve appears here once a plan completes and its buffer elapses.'}
              </Text>
            </Card>
          ) : (
            <Card bare style={styles.rows}>
              {(reserves.data ?? []).map((row, i) => (
                <ReserveRow key={row.id} row={row} divided={i > 0} />
              ))}
            </Card>
          )}
        </View>

        <View>
          <SectionLabel>Payout history</SectionLabel>
          {payouts.isPending ? (
            <Loading />
          ) : payouts.error ? (
            <Text variant="small" tone="muted">
              {apiErrorMessage(payouts.error, 'Could not load your payout history.')}
            </Text>
          ) : (payouts.data?.rows ?? []).length === 0 ? (
            <Card style={styles.blank}>
              <Text variant="smallMedium">No payouts yet</Text>
              <Text variant="tiny" tone="faint" style={styles.blankSub}>
                {/* A run that falls below the floor writes no row at all — it
                    returns before the insert — so an empty history does not
                    mean nothing has been earned, and saying otherwise would
                    worry a seller whose balance is simply still accumulating. */}
                Your first payout appears here once a run clears the floor.
              </Text>
            </Card>
          ) : (
            <Card bare style={styles.rows}>
              {(payouts.data?.rows ?? []).map((row, i) => (
                <PayoutRow key={row.id} row={row} divided={i > 0} />
              ))}
            </Card>
          )}
        </View>

        <Note eyebrow="Why reserve is held">
          Ejua withholds a percentage of every instalment sale until that customer&apos;s plan
          finishes, then releases it after the buffer for your plan type. A default can eat into it
          — that is what it is for.
        </Note>
      </View>
    </Screen>
  );
}

function ReserveRow({
  row,
  divided,
}: {
  row: MerchantHeldReserveRow;
  divided: boolean;
}): React.ReactElement {
  const released = row.fullyReleasedAt !== null;
  const consumed = row.consumedForDefaultPesewas > 0;

  // Four states, and the difference matters to a seller: released and in their
  // account; eaten by a default and never coming; waiting with a known date;
  // or waiting on a plan that has not finished, where there IS no date yet.
  const when = released
    ? `Released ${shortDate(row.fullyReleasedAt)}`
    : row.releasableFrom
      ? `Releases ${shortDate(row.releasableFrom)}`
      : 'Held until the plan completes';

  return (
    <View style={[styles.row, divided && styles.divided]}>
      <StatusDot tone={released ? 'primary' : consumed ? 'accent' : 'warn'} style={styles.rowDot} />
      <View style={styles.rowText}>
        <Text variant="smallMedium" numberOfLines={1}>
          {/* The canvas prints a plan reference here. There is no such column
              anywhere in the schema — a plan's only identifier is a uuid — so
              the order number stands in, and the item names the sale. */}
          {row.orderNumber ?? 'Order no longer on file'}
        </Text>
        {/* Two lines: "Demo Smartphone X · Held until the plan completes" does
            not fit one, and the half that gets cut is the half that says when
            the money moves. */}
        <Text variant="tiny" tone="faint" numberOfLines={2}>
          {row.itemSummary ? `${row.itemSummary} · ${when}` : when}
        </Text>
        {consumed ? (
          <Text variant="tiny" tone="accent">
            {`${ghs(row.consumedForDefaultPesewas)} went to cover a default`}
          </Text>
        ) : null}
      </View>
      <Text style={styles.rowValue}>
        {ghs(released ? row.releasedPesewas : row.outstandingPesewas)}
      </Text>
    </View>
  );
}

function PayoutRow({
  row,
  divided,
}: {
  row: MerchantPayoutRow;
  divided: boolean;
}): React.ReactElement {
  // Six statuses, not two. `reversed` is the one that must not read as a
  // success: the money went out and came back, and a seller who sees "Payout"
  // beside it will reconcile against a MoMo statement that does not agree.
  const failed = row.status === 'failed' || row.status === 'reversed';
  const settled = row.status === 'settled';
  const title = failed
    ? row.status === 'reversed'
      ? 'Payout reversed'
      : 'Payout failed'
    : settled
      ? 'Payout'
      : 'Payout on its way';
  return (
    <View style={[styles.row, divided && styles.divided]}>
      <View style={[styles.payoutIcon, failed && styles.payoutIconFailed]}>
        <Icon
          name={failed ? 'alert' : 'arrow-up'}
          size={15}
          color={failed ? color.accent : color.primary}
        />
      </View>
      <View style={styles.rowText}>
        <Text variant="smallMedium" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="tiny" tone="faint" numberOfLines={1}>
          {dateTime(row.settledAt ?? row.failedAt ?? row.initiatedAt)}
        </Text>
        {failed && row.lastError ? (
          <Text variant="tiny" tone="accent" numberOfLines={2}>
            {row.lastError}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.rowValue, failed && styles.rowValueFailed]}>
        {cedis(row.amountPesewas)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: color.darkCanvas,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
  },
  heroHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroValue: { marginTop: space.sm, marginBottom: 2 },
  heroNote: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    marginTop: space.lg,
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    padding: space.md,
  },
  heroNoteText: { flex: 1, lineHeight: 16 },

  body: { padding: space.lg, gap: space.xl },
  tiles: { flexDirection: 'row', gap: space.md },
  reserveChips: { marginBottom: space.md },

  rows: { paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  rowDot: { marginTop: 6 },
  rowText: { flex: 1, gap: 1 },
  rowValue: { fontFamily: font.bold, fontSize: 14.5, color: color.ink, letterSpacing: -0.2 },
  rowValueFailed: { color: color.accent },
  payoutIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: color.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payoutIconFailed: { backgroundColor: color.accentTint },

  blank: { paddingVertical: space.md },
  blankSub: { marginTop: 2 },
});
