import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Header,
  Loading,
  ReturnStatusPill,
  Screen,
  Text,
} from '../../src/components';
import { useMyReturns, useWithdrawReturn } from '../../src/features/returns';
import {
  CUSTOMER_RETURN_BUCKETS,
  type CustomerReturnBucket,
  type CustomerReturnCounts,
  type CustomerReturnRow,
} from '../../src/features/types';
import { ghsExact } from '../../src/lib/format';
import { shortDate } from '../../src/lib/dates';
import { color, radius, space, tintFor } from '../../src/theme/tokens';

/** The buyer's word for each bucket. `all` leads because most lists are short. */
const CHIP: Record<CustomerReturnBucket, string> = {
  all: 'All',
  requested: 'Waiting',
  approved: 'Agreed',
  rejected: 'Refused',
  cancelled: 'Withdrawn',
};

/**
 * `all` leads because most buyers have a short list; the rest keep the
 * contract's own order. Derived from `CUSTOMER_RETURN_BUCKETS` rather than
 * written out, so a fifth status appears here the day it is added instead of
 * being silently unfilterable.
 */
const ORDER = [
  'all',
  ...CUSTOMER_RETURN_BUCKETS.filter((b) => b !== 'all'),
] as CustomerReturnBucket[];

/**
 * Everything the buyer has asked to send back.
 *
 * `GET /me/returns` shipped with no caller, so this list is the first thing in
 * any client to read it — and the seller's queue, built to decide on these
 * requests, could only ever read empty in production until a buyer could make
 * one.
 *
 * The withdraw control is the other half. `order_returns.status = 'cancelled'`
 * has been in the CHECK since 0020, in `RETURN_STATUSES`, in the seller's
 * filter chips and in an empty state reading "A buyer can withdraw a request
 * before you decide on it" — and nothing in the system could set it. The copy
 * was not a promise the product was slow to keep; it was one nothing could.
 */
export default function MyReturnsScreen(): React.ReactElement {
  const [bucket, setBucket] = useState<CustomerReturnBucket>('all');
  const returns = useMyReturns(bucket);
  const withdraw = useWithdrawReturn();
  const [error, setError] = useState<string | null>(null);

  const page = returns.data;

  return (
    <Screen refreshing={returns.isRefetching} onRefresh={() => void returns.refetch()}>
      <Header title="My returns" back />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {ORDER.map((b) => (
          <Chip
            key={b}
            label={label(b, page?.counts)}
            selected={b === bucket}
            onPress={() => setBucket(b)}
          />
        ))}
      </ScrollView>

      <View style={styles.body}>
        {error ? (
          <Text variant="tiny" tone="accent">
            {error}
          </Text>
        ) : null}

        {returns.isPending ? (
          <Loading />
        ) : returns.error ? (
          <ErrorState
            message={apiErrorMessage(returns.error, 'We could not load your returns.')}
            onRetry={() => void returns.refetch()}
          />
        ) : page && page.rows.length > 0 ? (
          page.rows.map((row) => (
            <ReturnCard
              key={row.id}
              row={row}
              busy={withdraw.isPending}
              onWithdraw={() => confirmWithdraw(row)}
            />
          ))
        ) : (
          <EmptyState
            title={bucket === 'all' ? 'Nothing sent back' : `Nothing ${CHIP[bucket].toLowerCase()}`}
            body={
              bucket === 'all'
                ? 'When something is not right, open the order and ask to send it back. The seller decides, and Ejua refunds you if they agree.'
                : 'Try another filter.'
            }
          />
        )}
      </View>
    </Screen>
  );

  function confirmWithdraw(row: CustomerReturnRow): void {
    Alert.alert(
      'Withdraw this request?',
      `The seller stops seeing it. You can ask again for ${row.orderNumber} while the return window is open.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => {
            setError(null);
            withdraw.mutate(
              { id: row.id, orderId: row.orderId },
              { onError: (err) => setError(apiErrorMessage(err, 'We could not withdraw that.')) },
            );
          },
        },
      ],
    );
  }
}

/** "Waiting 1", or just "Waiting" when there are none and none to advertise. */
function label(bucket: CustomerReturnBucket, counts: CustomerReturnCounts | undefined): string {
  const n = counts?.[bucket];
  return n ? `${CHIP[bucket]} ${n}` : CHIP[bucket];
}

function ReturnCard({
  row,
  busy,
  onWithdraw,
}: {
  row: CustomerReturnRow;
  busy: boolean;
  onWithdraw: () => void;
}): React.ReactElement {
  return (
    <Card>
      <View style={styles.head}>
        <Text variant="eyebrow" tone="faint" style={styles.headNumber}>
          {row.orderNumber}
        </Text>
        <ReturnStatusPill status={row.status} />
      </View>

      <View style={styles.media}>
        {/* The same tinted block the orders tab uses for a line. `order_items`
            carries no image, and the seller's equivalent screen ships without
            one too. */}
        <View style={[styles.thumb, { backgroundColor: tintFor(row.orderId) }]} />
        <View style={styles.mediaText}>
          <Text variant="bodyMedium" numberOfLines={2}>
            {row.itemSummary ?? 'This order'}
          </Text>
          <Text variant="tiny" tone="muted">
            {when(row)}
          </Text>
        </View>
        <Text variant="smallMedium">{ghsExact(row.refundPesewas)}</Text>
      </View>

      <View style={styles.quote}>
        <Text variant="small" tone="muted" style={styles.quoteText}>
          {`“${row.reason}”`}
        </Text>
      </View>

      {row.decisionNote ? (
        <View style={styles.sellerNote}>
          <Text variant="eyebrow" tone="warn">
            THE SELLER SAID
          </Text>
          <Text variant="small" style={styles.quoteText}>
            {row.decisionNote}
          </Text>
        </View>
      ) : null}

      <Text variant="tiny" tone="faint" style={styles.footer}>
        {footer(row)}
      </Text>

      {row.canWithdraw ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Withdraw the request for ${row.orderNumber}`}
          disabled={busy}
          onPress={onWithdraw}
          style={[styles.withdraw, busy && styles.withdrawBusy]}
        >
          <Text variant="smallMedium" tone="accent">
            {busy ? 'Withdrawing…' : 'Withdraw this request'}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

/**
 * The date, labelled by what happened on it.
 *
 * `decidedAt` is null for `requested` AND for `cancelled` —
 * `order_returns_decided_together` requires it, because a withdrawal is not a
 * decision — so both of those fall back to when the buyer asked.
 */
function when(row: CustomerReturnRow): string {
  switch (row.status) {
    case 'approved':
      return `Agreed ${shortDate(row.decidedAt)}`;
    case 'rejected':
      return `Refused ${shortDate(row.decidedAt)}`;
    case 'cancelled':
      return `Asked ${shortDate(row.requestedAt)} · withdrawn`;
    default:
      return `Asked ${shortDate(row.requestedAt)}`;
  }
}

/**
 * What this means for the buyer's money, and nothing it cannot back up.
 *
 * The `approved` line deliberately does not name a wallet or a date. Approving
 * books `refund_payable` in the ledger and does NOT move cash — the disbursement
 * is a separate step — and `order_returns` carries no field saying where the
 * money goes or when it lands. Promising "on its way to your MoMo" would be a
 * sentence the record cannot support.
 */
function footer(row: CustomerReturnRow): string {
  switch (row.status) {
    case 'approved':
      return `The seller agreed. ${ghsExact(row.refundPesewas)} is being refunded to you.`;
    case 'rejected':
      return 'The order stands. Nothing was charged or refunded.';
    case 'cancelled':
      return 'You took this back. The order stands, and you can ask again while the window is open.';
    default:
      return 'Nothing has changed on your order yet.';
  }
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  body: { paddingHorizontal: space.lg, gap: space.md },

  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headNumber: { flex: 1 },

  media: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md },
  thumb: { width: 52, height: 52, borderRadius: radius.sm },
  mediaText: { flex: 1, gap: 2 },

  quote: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
  },
  quoteText: { lineHeight: 20 },
  sellerNote: {
    backgroundColor: color.warnTint,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.sm,
    gap: space.xs,
  },
  footer: { marginTop: space.md, lineHeight: 16 },
  withdraw: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.borderSoft,
    alignItems: 'center',
  },
  withdrawBusy: { opacity: 0.55 },
});
