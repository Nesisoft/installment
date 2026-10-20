import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantPlanDetail, MerchantPlanInstallment } from '@installment/api-types';
import {
  Button,
  Card,
  ErrorState,
  Header,
  Line,
  Loading,
  Note,
  PlanStatusPill,
  Screen,
  SectionLabel,
  StatusDot,
  Text,
  Total,
  installmentLabel,
  isLateInstallment,
} from '../../src/components';
import { usePlan } from '../../src/features/merchant';
import { shortDate } from '../../src/lib/dates';
import { cedis, ghs } from '../../src/lib/format';
import { defaultRiskSentence } from '../../src/lib/risk';
import { color, font, radius, space } from '../../src/theme/tokens';

export default function PlanScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const plan = usePlan(id);

  const refresh = useCallback(() => {
    void plan.refetch();
  }, [plan]);

  if (plan.isPending) {
    return (
      <Screen>
        <Header back title="Plan" />
        <Loading />
      </Screen>
    );
  }

  if (plan.error || !plan.data) {
    return (
      <Screen>
        <Header back title="Plan" />
        <ErrorState
          message={apiErrorMessage(plan.error, 'Could not load this plan.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const p = plan.data;
  const stillToCollect = Math.max(0, p.totalPayablePesewas - p.collectedPesewas);

  return (
    <Screen refreshing={plan.isFetching} onRefresh={refresh}>
      <Header
        back
        title={p.orderNumber ?? 'Plan'}
        subtitle={[p.customerName, p.itemSummary].filter(Boolean).join(' · ') || undefined}
        right={<PlanStatusPill status={p.status} late={p.late} />}
      />

      <View style={styles.body}>
        <Card>
          <Text variant="eyebrow" tone="faint">
            COLLECTED FROM CUSTOMER
          </Text>
          <Text variant="h1" style={styles.hero}>
            {ghs(p.collectedPesewas)}
          </Text>
          <Text variant="small" tone="muted">
            {`of ${ghs(p.totalPayablePesewas)} · ${p.paidCount} of ${p.installmentCount} paid`}
          </Text>
          <View style={styles.track}>
            <View style={[styles.fill, { flex: Math.max(p.paidCount, 0) }]} />
            <View style={[styles.rest, { flex: Math.max(p.installmentCount - p.paidCount, 0) }]} />
          </View>
          <Text variant="tiny" tone={p.late ? 'accent' : 'faint'}>
            {p.nextDueDate
              ? `${p.late ? 'Overdue since' : 'Next payment'} ${shortDate(p.nextDueDate)}`
              : 'Nothing left to collect'}
          </Text>
        </Card>

        <Card>
          <Text variant="eyebrow" tone="faint" style={styles.eyebrow}>
            YOUR MONEY ON THIS PLAN
          </Text>
          {p.settledPesewas === 0 && p.mdrPesewas === 0 ? (
            // Nothing has accrued. On a staged model — layaway pays at
            // completion, hybrid splits 40/60 — that is normal and not an
            // error, so the card says which rather than showing zeroes.
            <Text variant="small" tone="muted">
              Nothing has been credited to you on this plan yet. Your plan type pays out later in
              the plan&apos;s life rather than at approval.
            </Text>
          ) : (
            <>
              <Line label="Order" value={ghs(p.orderAmountPesewas)} />
              <Line
                label="Ejua MDR"
                qualifier={`${p.mdrBps / 100}%`}
                value={`−${ghs(p.mdrPesewas)}`}
                deduction
              />
              {p.reserveWithheldPesewas > 0 ? (
                <Line
                  label="Reserve withheld"
                  qualifier={`${p.reserveBps / 100}%`}
                  value={`−${ghs(p.reserveWithheldPesewas)}`}
                  deduction
                />
              ) : null}
              <Total label="Credited to you" value={ghs(p.settledPesewas)} />
            </>
          )}

          {p.reserveOutstandingPesewas > 0 ? (
            <View style={styles.reserve}>
              <Note eyebrow="Reserve still held" tone="warn">
                {`${ghs(p.reserveOutstandingPesewas)} of your money is still held against this plan. ${
                  p.reserveReleasesAt
                    ? `It becomes releasable from ${shortDate(p.reserveReleasesAt)}.`
                    : 'It is held until the plan completes — the release clock only starts then.'
                }`}
              </Note>
            </View>
          ) : null}

          <View style={styles.collect}>
            <Line label="Still to collect from the customer" value={ghs(stillToCollect)} />
            <Text variant="tiny" tone="faint">
              Ejua collects this, not you.
            </Text>
          </View>
        </Card>

        <View>
          <SectionLabel>Repayment schedule</SectionLabel>
          <Card bare style={styles.rows}>
            {p.installments.map((row, i) => (
              <InstallmentRow key={row.sequence_number} row={row} divided={i > 0} plan={p} />
            ))}
          </Card>
        </View>

        <Note eyebrow="Who carries the risk">
          {`Ejua lends the customer the money and collects every payment. ${defaultRiskSentence(p.business_model)}`}
        </Note>

        {p.orderId ? (
          <Button
            label="Open the order"
            variant="outline"
            onPress={() => router.push(`/orders/${p.orderId}`)}
          />
        ) : null}
      </View>
    </Screen>
  );
}

function InstallmentRow({
  row,
  divided,
  plan,
}: {
  row: MerchantPlanInstallment;
  divided: boolean;
  plan: MerchantPlanDetail;
}): React.ReactElement {
  const label = installmentLabel(row.status);
  const late = isLateInstallment(row.status);
  const paid = row.status === 'paid';
  // The first row is the deposit only where the plan has one, and the plan
  // payload does not say. `sequence_number` 1 falling due on the plan's own
  // creation day is the tell the schedule actually carries.
  const isDeposit = row.sequence_number === 1 && row.due_date <= plan.createdAt.slice(0, 10);

  return (
    <View style={[styles.row, divided && styles.divided]}>
      <View style={styles.seq}>
        <Text style={styles.seqText}>{row.sequence_number}</Text>
      </View>
      <View style={styles.rowText}>
        <Text variant="smallMedium">{ghs(row.amount_due_pesewas)}</Text>
        <Text variant="tiny" tone="faint">
          {isDeposit ? `Deposit · ${shortDate(row.due_date)}` : shortDate(row.due_date)}
        </Text>
        {row.late_fee_pesewas > 0 ? (
          <Text variant="tiny" tone="accent">
            {`${ghs(row.late_fee_pesewas)} late fee added`}
          </Text>
        ) : null}
      </View>
      <View style={styles.state}>
        <StatusDot tone={paid ? 'primary' : late ? 'accent' : 'muted'} style={styles.stateDot} />
        <Text variant="tiny" tone={paid ? 'primary' : late ? 'accent' : 'faint'}>
          {label.label}
        </Text>
        {row.amount_paid_pesewas > 0 && !paid ? (
          <Text variant="tiny" tone="faint">
            {`${cedis(row.amount_paid_pesewas)} so far`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg },
  hero: { marginTop: 2 },
  eyebrow: { marginBottom: space.sm },

  track: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    gap: 2,
    marginVertical: space.md,
  },
  fill: { backgroundColor: color.primary, borderRadius: 3 },
  rest: { backgroundColor: color.surfaceSunk, borderRadius: 3 },

  reserve: { marginTop: space.md },
  collect: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.borderSoft,
  },

  rows: { paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  seq: {
    width: 24,
    height: 24,
    borderRadius: radius.xs,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seqText: { fontFamily: font.bold, fontSize: 11.5, color: color.muted },
  rowText: { flex: 1 },
  state: { alignItems: 'flex-end', flexDirection: 'row', gap: 5 },
  stateDot: {},
});
