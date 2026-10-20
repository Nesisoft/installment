import React, { useRef, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage, apiErrorStatus, newIdempotencyKey } from '@installment/mobile-kit';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  InstallmentStatusPill,
  Loading,
  Screen,
  SectionLabel,
  Text,
} from '../../src/components';
import {
  useInstallments,
  useNextInstallment,
  usePayInstallmentMomo,
  usePlans,
  useProfile,
  useSetAutopay,
} from '../../src/features/account';
import { ghs, pluralise } from '../../src/lib/format';
import { relativeDate, shortDate } from '../../src/lib/dates';
import { color, radius, space } from '../../src/theme/tokens';
import type { CustomerPlan, FeedInstallment } from '../../src/features/types';

export default function InstallmentsScreen(): React.ReactElement {
  const feed = useInstallments('all');
  const next = useNextInstallment();
  const plans = usePlans();
  // A Mobile Money number on file is what both the pay button and the
  // auto-debit charge; without one the server refuses the first and the second
  // has nothing to collect from.
  const profile = useProfile();
  const noNumber = profile.data !== undefined && !profile.data.momo_phone;

  if (feed.isPending || plans.isPending) {
    return (
      <Screen>
        <Header title="My instalments" back />
        <Loading />
      </Screen>
    );
  }

  if (feed.isError) {
    return (
      <Screen>
        <Header title="My instalments" back />
        <ErrorState message="We couldn't load your plans." onRetry={() => void feed.refetch()} />
      </Screen>
    );
  }

  const rows = feed.data ?? [];
  const allPlans = plans.data ?? [];

  if (allPlans.length === 0) {
    return (
      <Screen>
        <Header title="My instalments" back />
        <EmptyState
          icon={<Icon name="card" size={30} color={color.mutedSoft} />}
          title="No instalment plans yet"
          body="Choose “pay in instalments” at checkout and your schedule will appear here."
          action={<Button label="Start shopping" onPress={() => router.replace('/')} />}
        />
      </Screen>
    );
  }

  return (
    <Screen refreshing={feed.isRefetching} onRefresh={() => void feed.refetch()}>
      <Header title="My instalments" back />

      <View style={styles.body}>
        {next.data ? <NextPayment installment={next.data} noNumber={noNumber} /> : <AllClear />}

        {allPlans
          .filter((plan) => plan.status === 'active' || plan.status === 'in_arrears')
          .map((plan) => (
            <AutopayRow key={plan.id} plan={plan} rows={rows} noNumber={noNumber} />
          ))}

        <SectionLabel style={styles.sectionGap}>Payment schedule</SectionLabel>
        {groupByPlan(rows).map(([planId, planRows]) => (
          <PlanSchedule
            key={planId}
            rows={planRows}
            plan={allPlans.find((p) => p.id === planId) ?? null}
          />
        ))}

        <MissedPaymentNote plans={allPlans} />
      </View>
    </Screen>
  );
}

/**
 * The next thing owed, and the way to pay it.
 *
 * The headline is `payable_pesewas` — the instalment plus any accrued late fee —
 * because that is what a charge will actually collect. Where a fee is included
 * it is named explicitly: a customer must never be charged something they were
 * not shown.
 */
function NextPayment({
  installment,
  noNumber,
}: {
  installment: FeedInstallment;
  noNumber: boolean;
}): React.ReactElement {
  const pay = usePayInstallmentMomo();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // One key per attempt, kept across renders. A fresh key per tap would turn a
  // customer returning from the MoMo dialler into a second debit.
  const keys = useRef(new Map<string, string>());
  if (!keys.current.has(installment.id)) {
    keys.current.set(installment.id, newIdempotencyKey('installment'));
  }

  async function submit(): Promise<void> {
    setError(null);
    try {
      await pay.mutateAsync({
        scheduleId: installment.id,
        idempotencyKey: keys.current.get(installment.id) ?? newIdempotencyKey('installment'),
      });
      setSent(true);
    } catch (err) {
      // 409 = a charge is already running for this row. That is progress.
      if (apiErrorStatus(err) === 409) {
        setSent(true);
        return;
      }
      setError(apiErrorMessage(err, 'That payment did not go through.'));
    }
  }

  return (
    <Card dark style={styles.next}>
      <Text variant="eyebrow" tone="onDarkFaint">
        NEXT PAYMENT · {relativeDate(installment.due_date).toUpperCase()}
      </Text>
      <Text variant="display" tone="onDark" style={styles.nextAmount}>
        {ghs(installment.payable_pesewas)}
      </Text>
      {installment.late_fee_pesewas > 0 ? (
        <Text variant="tiny" tone="accent">
          Includes {ghs(installment.late_fee_pesewas)} late fee
        </Text>
      ) : null}
      <Text variant="small" tone="onDarkMuted">
        {installment.item_title ?? 'Instalment'} · instalment {installment.position} of{' '}
        {installment.total_installments}
      </Text>

      {error ? (
        <Text variant="small" tone="accent">
          {error}
        </Text>
      ) : null}

      {noNumber ? (
        <>
          {/* The charge takes the number on file, and there is none: the button
              this replaced was a 400 the customer could not get past. */}
          <Text variant="small" tone="onDarkMuted">
            There is no Mobile Money number on your account to take this from.
          </Text>
          <Button
            label="Add a Mobile Money number"
            onPress={() => router.push('/wallet')}
            style={styles.nextCta}
          />
        </>
      ) : (
        <Button
          label={
            sent ? 'Check your phone' : `Pay ${ghs(installment.payable_pesewas)} on Mobile Money`
          }
          loading={pay.isPending}
          disabled={sent}
          onPress={() => void submit()}
          style={styles.nextCta}
        />
      )}
      {sent ? (
        <Text variant="tiny" tone="onDarkFaint" center>
          Approve the prompt to finish. This page updates once it clears.
        </Text>
      ) : null}
    </Card>
  );
}

function AllClear(): React.ReactElement {
  return (
    <Card style={styles.clear}>
      <Icon name="check" size={20} color={color.success} strokeWidth={2.6} />
      <View style={styles.clearText}>
        <Text variant="smallMedium">Nothing due right now</Text>
        <Text variant="tiny" tone="muted">
          You are up to date on every plan.
        </Text>
      </View>
    </Card>
  );
}

/**
 * The auto-debit switch.
 *
 * The copy states the REAL retry policy (four attempts) rather than the design's
 * "we retry twice", and says plainly that switching off does not waive anything —
 * late-fee accrual deliberately ignores this flag.
 */
function AutopayRow({
  plan,
  rows,
  noNumber,
}: {
  plan: CustomerPlan;
  rows: FeedInstallment[];
  noNumber: boolean;
}): React.ReactElement {
  const setAutopay = useSetAutopay();
  const label = rows.find((r) => r.customer_plan_id === plan.id)?.item_title;

  return (
    <Card style={styles.autopay}>
      <View style={styles.autopayText}>
        <Text variant="smallMedium">Automatic Mobile Money collection</Text>
        {label ? (
          <Text variant="tiny" tone="faint">
            {label}
          </Text>
        ) : null}
        {noNumber ? (
          <Text variant="tiny" tone="accent" style={styles.autopayBody}>
            There is no Mobile Money number on your account to collect from. Add one in Wallet.
          </Text>
        ) : null}
        <Text variant="tiny" tone="muted" style={styles.autopayBody}>
          We try four times — straight away, after 4 hours, after 24 hours, then we send you a
          payment link. Turning this off only stops us collecting on our own; the instalment
          {plan.late_fee_bps_per_week > 0 ? ' and any late fee' : ''} is still due.
        </Text>
      </View>
      <Switch
        value={plan.autopay_enabled}
        disabled={setAutopay.isPending}
        onValueChange={(enabled) => setAutopay.mutate({ planId: plan.id, enabled })}
        trackColor={{ true: color.success, false: color.borderStrong }}
        accessibilityLabel="Automatic Mobile Money collection"
      />
    </Card>
  );
}

function PlanSchedule({
  rows,
  plan,
}: {
  rows: FeedInstallment[];
  plan: CustomerPlan | null;
}): React.ReactElement {
  const first = rows[0];
  return (
    <Card bare style={styles.schedule}>
      <View style={styles.scheduleHead}>
        <Text variant="smallMedium" numberOfLines={1}>
          {first?.item_title ?? first?.merchant_name ?? 'Instalment plan'}
        </Text>
        {plan ? (
          <Text variant="tiny" tone="muted">
            {ghs(plan.outstanding_pesewas)} left of {ghs(plan.total_payable_pesewas)}
          </Text>
        ) : null}
      </View>

      {rows.map((row) => (
        <View key={row.id} style={styles.scheduleRow}>
          <View style={[styles.seq, row.status === 'paid' && styles.seqPaid]}>
            <Text variant="tiny" tone={row.status === 'paid' ? 'onDark' : 'muted'}>
              {row.position}
            </Text>
          </View>
          <View style={styles.scheduleText}>
            <Text variant="smallMedium" tone={row.status === 'paid' ? 'faint' : 'ink'}>
              {ghs(row.payable_pesewas)}
            </Text>
            <Text variant="tiny" tone="muted">
              {row.status === 'paid' ? 'Paid' : 'Due'} {shortDate(row.due_date)}
              {row.is_down_payment ? ' · deposit' : ''}
            </Text>
          </View>
          <InstallmentStatusPill status={row.status} overdue={row.is_overdue} />
        </View>
      ))}
    </Card>
  );
}

/**
 * The late-fee explainer, built from the plan's own rate and cap.
 *
 * Basis points: 200 bps = 2% per week, 1500 bps = a 15% cap. A plan sold without
 * a rate never grows one, so the note says so rather than quoting terms that do
 * not apply.
 */
function MissedPaymentNote({ plans }: { plans: CustomerPlan[] }): React.ReactElement | null {
  const plan = plans.find((p) => p.status === 'active') ?? plans[0];
  if (!plan) return null;

  const hasFee = plan.late_fee_bps_per_week > 0;

  return (
    <Card style={styles.note}>
      <Text variant="smallMedium">If you miss a payment</Text>
      <Text variant="tiny" tone="muted">
        {plan.grace_period_days > 0
          ? `You get ${pluralise(plan.grace_period_days, 'day')} of grace after the due date. `
          : 'A payment is due on its date. '}
        {hasFee
          ? `After that a late fee of ${plan.late_fee_bps_per_week / 100}% per week applies to the amount overdue, capped at ${plan.late_fee_cap_bps / 100}% of the instalment.`
          : 'There is no late fee on this plan.'}{' '}
        Your Ejua limit pauses until you catch up.
      </Text>
    </Card>
  );
}

function groupByPlan(rows: FeedInstallment[]): [string, FeedInstallment[]][] {
  const groups = new Map<string, FeedInstallment[]>();
  for (const row of rows) {
    const bucket = groups.get(row.customer_plan_id);
    if (bucket) bucket.push(row);
    else groups.set(row.customer_plan_id, [row]);
  }
  return [...groups.entries()];
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  next: { gap: 4 },
  nextAmount: { marginVertical: 2 },
  nextCta: { marginTop: space.md },
  clear: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  clearText: { flex: 1, gap: 2 },
  autopay: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  autopayText: { flex: 1, gap: 2 },
  autopayBody: { marginTop: 2 },
  sectionGap: { marginTop: space.md, marginBottom: 0 },
  schedule: { paddingVertical: space.sm },
  scheduleHead: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
    gap: 2,
  },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  seq: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seqPaid: { backgroundColor: color.success },
  scheduleText: { flex: 1, gap: 1 },
  note: { gap: 4 },
});
