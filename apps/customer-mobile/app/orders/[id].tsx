import React, { useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage, apiErrorStatus, newIdempotencyKey } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Header,
  Loading,
  OrderStatusPill,
  Screen,
  SectionLabel,
  Text,
} from '../../src/components';
import {
  useCancelOrder,
  useOrder,
  useOrderTracking,
  usePayOrderMomo,
} from '../../src/features/shop';
import { useInstallments } from '../../src/features/account';
import { useOpenReturnFor } from '../../src/features/returns';
import { ghs, pluralise } from '../../src/lib/format';
import { dateTime, longDate, parseApiDate, relativeDate } from '../../src/lib/dates';
import { color, radius, space } from '../../src/theme/tokens';
import type { OrderEvent } from '../../src/features/types';

/**
 * Steps a customer expects to see but which have not happened yet.
 *
 * Rendered greyed and undated below the real events, so the timeline reads as a
 * journey with a known end rather than stopping wherever the order currently
 * is. Anything already recorded is filtered out by label.
 */
const EXPECTED_TAIL = ['Delivered', 'Return window closes', 'Vendor settled'];

/**
 * The order statuses `ReturnsService.request` will accept.
 *
 * A copy of `RETURNABLE_STATUSES`, which is not exported from the contract —
 * so this is a second definition and it can drift. It is here rather than
 * absent because the alternative is offering the control on every order and
 * letting the server refuse: this list only decides whether a link is drawn,
 * and the request screen re-checks every rule and names the blocker.
 */
const RETURNABLE: string[] = ['paid', 'shipped', 'delivered'];

export default function OrderDetailScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const order = useOrder(id ?? '', { pollMs: 8_000 });
  const tracking = useOrderTracking(id ?? '');
  const installments = useInstallments('all');

  const [error, setError] = useState<string | null>(null);
  const payOrder = usePayOrderMomo(id ?? '');
  const cancel = useCancelOrder(id ?? '');
  // The one eligibility rule that is not on the order itself.
  const openReturn = useOpenReturnFor(id ?? '', Boolean(id));
  const payKey = useRef(newIdempotencyKey('order-pay'));

  if (!id) {
    return (
      <Screen>
        <Header title="Order" back />
        <ErrorState message="We could not find that order." />
      </Screen>
    );
  }

  if (order.isPending) {
    return (
      <Screen>
        <Header title="Order" back />
        <Loading />
      </Screen>
    );
  }

  if (order.isError || !order.data) {
    return (
      <Screen>
        <Header title="Order" back />
        <ErrorState message="We couldn't load this order." onRetry={() => void order.refetch()} />
      </Screen>
    );
  }

  const data = order.data;
  // Null before delivery, and that is NOT "no window" — a paid or shipped
  // order is returnable and has simply not started its clock. Only a window
  // that exists and has passed closes the door.
  const windowEnds = parseApiDate(data.return_window_ends_at);
  const returnWindowClosed = windowEnds !== null && windowEnds.getTime() < Date.now();
  const shipment = tracking.data?.shipment ?? null;
  const events = tracking.data?.events ?? [];
  const latest = events[events.length - 1] ?? null;
  const canCancel = data.status === 'pending_payment' || data.status === 'pending_approval';

  const planRows = (installments.data ?? []).filter(
    (row) => data.customer_plan_id && row.customer_plan_id === data.customer_plan_id,
  );
  const nextPayment = planRows.find((row) => row.status !== 'paid' && row.status !== 'refunded');

  async function pay(): Promise<void> {
    setError(null);
    try {
      await payOrder.mutateAsync({ idempotencyKey: payKey.current });
    } catch (err) {
      // A charge already in flight is progress, not a failure — the poll will
      // pick up the result.
      if (apiErrorStatus(err) === 409) return;
      setError(apiErrorMessage(err, 'That payment did not go through.'));
    }
  }

  function confirmCancel(): void {
    Alert.alert('Cancel this order?', 'The items go back on sale and nothing is charged.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel order',
        style: 'destructive',
        onPress: () => {
          cancel.mutate(undefined, {
            onError: (err) => setError(apiErrorMessage(err, 'We could not cancel that order.')),
          });
        },
      },
    ]);
  }

  return (
    <Screen refreshing={order.isRefetching} onRefresh={() => void order.refetch()}>
      <Header
        title={data.order_number}
        subtitle={`Placed ${longDate(data.placed_at ?? data.created_at)} · ${pluralise(data.items.length, 'item')}`}
        back
        right={<OrderStatusPill status={data.status} />}
      />

      <View style={styles.body}>
        <Card dark style={styles.status}>
          <Text variant="eyebrow" tone="onDarkFaint">
            CURRENT STATUS
          </Text>
          <Text variant="h3" tone="onDark">
            {latest?.label ?? 'Order placed'}
          </Text>
          {latest?.detail ? (
            <Text variant="small" tone="onDarkMuted">
              {latest.detail}
            </Text>
          ) : null}

          {shipment ? (
            <View style={styles.shipment}>
              {shipment.rider_name || shipment.courier_name ? (
                <Text variant="small" tone="onDarkMuted">
                  {[shipment.rider_name, shipment.courier_name].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
              {shipment.eta_at ? (
                <Text variant="small" tone="onDarkMuted">
                  Arriving by {dateTime(shipment.eta_at)}
                </Text>
              ) : null}
              <View style={styles.shipmentActions}>
                {/* Only actions whose data exists — a dead "Call rider" button is
                    worse than no button at all. */}
                {shipment.courier_phone ? (
                  <Button
                    label="Call rider"
                    variant="ghost"
                    compact
                    full={false}
                    onPress={() => void Linking.openURL(`tel:${shipment.courier_phone}`)}
                  />
                ) : null}
                {shipment.tracking_code ? (
                  <Button
                    label="Copy tracking code"
                    variant="ghost"
                    compact
                    full={false}
                    onPress={() => void Clipboard.setStringAsync(shipment.tracking_code ?? '')}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </Card>

        <SectionLabel style={styles.sectionGap}>Progress</SectionLabel>
        <Card>
          {events.map((event, index) => (
            <TimelineRow
              key={`${event.event_type}-${event.occurred_at}`}
              label={event.label}
              detail={event.detail}
              when={dateTime(event.occurred_at)}
              state={index === events.length - 1 ? 'current' : 'done'}
              last={index === events.length - 1 && expectedTail(events).length === 0}
            />
          ))}
          {expectedTail(events).map((label, index, all) => (
            <TimelineRow
              key={label}
              label={label}
              when={null}
              state="pending"
              last={index === all.length - 1}
            />
          ))}
        </Card>

        {/* Was this sentence and nothing else: "Free returns until <date>",
            static text on a screen with no way to start one, next to a seller
            queue that could only ever read empty. The sentence stays, because
            it is the promise; what is new is that it now leads somewhere.

            Only for outright purchases. An instalment order is unwound with
            its credit plan, which `ReturnsService.request` refuses outright —
            offering the control here would be inviting a 422. */}
        {data.payment_type === 'full' && RETURNABLE.includes(data.status) ? (
          <Card style={styles.returnsCard}>
            <Text variant="tiny" tone="muted" style={styles.returns}>
              {data.return_window_ends_at
                ? `Free returns until ${longDate(data.return_window_ends_at)}. The vendor is paid only once that window closes.`
                : 'Free returns for a week after it reaches you. The vendor is paid only once that window closes.'}
            </Text>
            {openReturn ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/returns')}
                style={styles.returnsCta}
              >
                <Text variant="smallMedium" tone="warn">
                  You asked to send this back — see what the seller said
                </Text>
              </Pressable>
            ) : returnWindowClosed ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/returns/new?order=${data.id}`)}
                style={styles.returnsCta}
              >
                <Text variant="smallMedium" tone="accent">
                  Something wrong? Ask to send it back
                </Text>
              </Pressable>
            )}
          </Card>
        ) : data.return_window_ends_at ? (
          <Text variant="tiny" tone="muted" style={styles.returns}>
            Free returns until {longDate(data.return_window_ends_at)}. The vendor is paid only once
            that window closes.
          </Text>
        ) : null}

        <SectionLabel style={styles.sectionGap}>Items</SectionLabel>
        <Card style={styles.items}>
          {data.items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <Text variant="small" tone="muted" style={styles.itemTitle} numberOfLines={2}>
                {item.title} × {item.quantity}
              </Text>
              <Text variant="smallMedium">{ghs(item.line_total_pesewas)}</Text>
            </View>
          ))}
          <View style={styles.rule} />
          <View style={styles.itemRow}>
            <Text variant="small" tone="muted" style={styles.itemTitle}>
              Delivery
            </Text>
            <Text variant="smallMedium">
              {data.shipping_pesewas === 0 ? 'Free' : ghs(data.shipping_pesewas)}
            </Text>
          </View>
          <View style={styles.itemRow}>
            <Text variant="bodyMedium" style={styles.itemTitle}>
              Total
            </Text>
            <Text variant="price">{ghs(data.total_pesewas)}</Text>
          </View>
        </Card>

        {nextPayment ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Instalment ${nextPayment.position} of ${nextPayment.total_installments}. View your plan.`}
            onPress={() => router.push('/plans')}
          >
            <Card style={styles.planCard}>
              <View style={styles.planText}>
                <Text variant="smallMedium">
                  Instalment {nextPayment.position} of {nextPayment.total_installments}
                </Text>
                <Text variant="tiny" tone="muted">
                  {ghs(nextPayment.payable_pesewas)} due {relativeDate(nextPayment.due_date)}
                </Text>
              </View>
              <Text variant="smallMedium" tone="accent">
                View plan ›
              </Text>
            </Card>
          </Pressable>
        ) : null}

        {error ? (
          <Text variant="small" tone="accent">
            {error}
          </Text>
        ) : null}

        {data.status === 'pending_payment' ? (
          <Button
            label={`Pay ${ghs(data.total_pesewas)} on Mobile Money`}
            loading={payOrder.isPending}
            onPress={() => void pay()}
          />
        ) : null}

        {canCancel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel this order"
            onPress={confirmCancel}
            style={styles.cancel}
          >
            <Text variant="smallMedium" tone="muted">
              Cancel order
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

function expectedTail(events: OrderEvent[]): string[] {
  const seen = new Set(events.map((e) => e.label));
  return EXPECTED_TAIL.filter((label) => !seen.has(label));
}

function TimelineRow({
  label,
  detail,
  when,
  state,
  last,
}: {
  label: string;
  detail?: string | null;
  when: string | null;
  state: 'done' | 'current' | 'pending';
  last?: boolean;
}): React.ReactElement {
  const dotColor =
    state === 'current' ? color.accent : state === 'done' ? color.success : color.surface;
  const ringColor =
    state === 'current' ? color.accent : state === 'done' ? color.success : color.borderStrong;

  return (
    <View style={styles.timelineRow}>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: dotColor, borderColor: ringColor }]} />
        {!last ? (
          <View
            style={[
              styles.line,
              { backgroundColor: state === 'pending' ? color.borderSoft : color.successLine },
            ]}
          />
        ) : null}
      </View>
      <View style={styles.timelineText}>
        <Text variant="smallMedium" tone={state === 'pending' ? 'faint' : 'ink'}>
          {label}
        </Text>
        {detail ? (
          <Text variant="tiny" tone="muted">
            {detail}
          </Text>
        ) : null}
        {when ? (
          <Text variant="tiny" tone="faint">
            {when}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  status: { gap: 4 },
  shipment: { marginTop: space.md, gap: space.sm },
  shipmentActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  sectionGap: { marginTop: space.md, marginBottom: 0 },
  timelineRow: { flexDirection: 'row', gap: space.md },
  rail: { alignItems: 'center', width: 14 },
  dot: { width: 12, height: 12, borderRadius: radius.pill, borderWidth: 2 },
  line: { width: 2, flex: 1, minHeight: 22, marginVertical: 2 },
  timelineText: { flex: 1, paddingBottom: space.lg, gap: 1 },
  returns: { paddingHorizontal: 2, lineHeight: 16 },
  returnsCard: { gap: space.md },
  returnsCta: {
    borderTopWidth: 1,
    borderTopColor: color.borderSoft,
    paddingTop: space.md,
  },
  items: { gap: space.sm },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  itemTitle: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginVertical: 2 },
  planCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  planText: { flex: 1, gap: 2 },
  cancel: { alignItems: 'center', paddingVertical: space.md },
});
