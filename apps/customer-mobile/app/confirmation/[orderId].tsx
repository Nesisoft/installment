import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  ErrorState,
  Icon,
  Loading,
  Screen,
  SectionLabel,
  Text,
} from '../../src/components';
import { useOrder } from '../../src/features/shop';
import { ghs } from '../../src/lib/format';
import { longDate, shortDate } from '../../src/lib/dates';
import { color, radius, space } from '../../src/theme/tokens';

/** Statuses that mean the money has not landed yet. */
const AWAITING = ['pending_payment', 'pending_approval'];

export default function ConfirmationScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ orderId?: string | string[] }>();
  const orderId = Array.isArray(params.orderId) ? params.orderId[0] : params.orderId;

  // A Mobile Money charge settles by webhook, not in our response. Polling is
  // what turns this screen from "waiting" into "confirmed" on its own, instead
  // of asking a customer who has just paid to pull down and refresh.
  const order = useOrder(orderId ?? '', { pollMs: 4_000 });

  if (!orderId) {
    return (
      <Screen dark>
        <ErrorState message="We could not find that order." />
      </Screen>
    );
  }

  if (order.isPending) {
    return (
      <Screen dark>
        <Loading dark />
      </Screen>
    );
  }

  if (order.isError || !order.data) {
    return (
      <Screen dark>
        <ErrorState message="We couldn't load your order." onRetry={() => void order.refetch()} />
      </Screen>
    );
  }

  const data = order.data;
  const waiting = AWAITING.includes(data.status);
  const plan = data.plan;

  // Sequence 1 is the deposit when the plan has one; it is either paid or being
  // paid right now, so the "remaining" list starts after it.
  const remaining = data.schedule.filter(
    (row) =>
      row.status !== 'paid' &&
      !(row.sequence_number === 1 && (plan?.down_payment_pesewas ?? 0) > 0),
  );

  const paidToday =
    plan && plan.down_payment_pesewas > 0 ? plan.down_payment_pesewas : data.total_pesewas;

  return (
    <Screen dark contentStyle={{ paddingTop: insets.top + space.xxxl }}>
      <View style={styles.body}>
        <View style={[styles.mark, waiting ? styles.markWaiting : styles.markDone]}>
          {waiting ? (
            <ActivityIndicator color={color.onDark} />
          ) : (
            <Icon name="check" size={30} color={color.onDark} strokeWidth={2.8} />
          )}
        </View>

        <Text variant="h1" tone="onDark">
          {waiting ? 'Almost there.' : 'Order confirmed.'}
          {'\n'}
          {waiting ? 'Approve it on your phone.' : "It's on the way."}
        </Text>

        <Text variant="body" tone="onDarkMuted">
          {waiting
            ? 'We are waiting for your Mobile Money approval. This screen updates on its own once it lands.'
            : data.fulfilment_method === 'pickup'
              ? `Ready for collection at ${data.pickup_hub?.name ?? 'your chosen hub'}.`
              : 'We will let you know as soon as it ships.'}
        </Text>

        <View style={styles.card}>
          <View style={styles.cardRow}>
            <Text variant="eyebrow" tone="onDarkFaint">
              ORDER
            </Text>
            <Text variant="smallMedium" tone="onDark">
              {data.order_number}
            </Text>
          </View>
          <View style={styles.rule} />
          <View style={styles.cardRow}>
            <Text variant="small" tone="onDarkMuted">
              {waiting ? 'To pay now' : 'Paid today'}
            </Text>
            <Text variant="h3" tone="onDark">
              {ghs(paidToday)}
            </Text>
          </View>

          {remaining.length > 0 ? (
            <>
              <View style={styles.rule} />
              <SectionLabel style={styles.scheduleHead}>Remaining schedule</SectionLabel>
              {remaining.map((row) => (
                <View key={row.id} style={styles.scheduleRow}>
                  <Text variant="small" tone="onDarkMuted">
                    {shortDate(row.due_date)}
                  </Text>
                  <Text variant="smallMedium" tone="onDark">
                    {ghs(row.amount_due_pesewas)}
                  </Text>
                </View>
              ))}
            </>
          ) : null}

          {data.return_window_ends_at ? (
            <>
              <View style={styles.rule} />
              <Text variant="tiny" tone="onDarkFaint">
                Free returns until {longDate(data.return_window_ends_at)}. The vendor is paid only
                once that window closes.
              </Text>
            </>
          ) : null}
        </View>

        <View style={styles.actions}>
          <Button label="Track my order" onPress={() => router.replace(`/orders/${data.id}`)} />
          <Button label="Keep shopping" variant="ghost" onPress={() => router.replace('/')} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.xxl, gap: space.lg },
  mark: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markDone: { backgroundColor: color.success },
  markWaiting: { backgroundColor: color.darkHover },
  card: {
    backgroundColor: color.darkRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    marginTop: space.sm,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.darkLine },
  scheduleHead: { marginBottom: 2 },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { gap: space.sm, marginTop: space.md },
});
