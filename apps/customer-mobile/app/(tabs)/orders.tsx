import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@installment/mobile-kit';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  Loading,
  OrderStatusPill,
  Screen,
  Text,
} from '../../src/components';
import { useOrders } from '../../src/features/shop';
import { useInstallments } from '../../src/features/account';
import { ghs, pluralise } from '../../src/lib/format';
import { relativeDate } from '../../src/lib/dates';
import { color, radius, space, tintFor } from '../../src/theme/tokens';
import type { FeedInstallment, Order } from '../../src/features/types';

export default function OrdersScreen(): React.ReactElement {
  const { signedIn } = useAuth();
  const orders = useOrders(signedIn);
  // The due strip on a card needs what is owed on THAT order, which only the
  // cross-plan feed knows — an order carries a plan id, not a next payment.
  const due = useInstallments('due', signedIn);

  if (!signedIn) {
    return (
      <Screen tabBar>
        <Header title="Orders" />
        <EmptyState
          icon={<Icon name="box" size={30} color={color.mutedSoft} />}
          title="Sign in to see your orders"
          body="Track deliveries and pay instalments from here."
          action={<Button label="Sign in" onPress={() => router.push('/onboarding')} />}
        />
      </Screen>
    );
  }

  const dueByOrder = new Map<string, FeedInstallment>();
  for (const row of due.data ?? []) {
    if (!row.order_id) continue;
    const existing = dueByOrder.get(row.order_id);
    // Earliest first: a card should surface the next thing owed, not the last.
    if (!existing || row.due_date < existing.due_date) dueByOrder.set(row.order_id, row);
  }

  return (
    <Screen tabBar refreshing={orders.isRefetching} onRefresh={() => void orders.refetch()}>
      <Header title="Orders" />

      {orders.isPending ? <Loading /> : null}
      {orders.isError ? (
        <ErrorState message="We couldn't load your orders." onRetry={() => void orders.refetch()} />
      ) : null}

      {orders.data && orders.data.length === 0 ? (
        <EmptyState
          icon={<Icon name="box" size={30} color={color.mutedSoft} />}
          title="No orders yet"
          body="When you buy something it will show up here, with its delivery and payment schedule."
          action={<Button label="Start shopping" onPress={() => router.push('/')} />}
        />
      ) : null}

      <View style={styles.list}>
        {(orders.data ?? []).map((order) => (
          <OrderCard key={order.id} order={order} due={dueByOrder.get(order.id) ?? null} />
        ))}
      </View>
    </Screen>
  );
}

function OrderCard({
  order,
  due,
}: {
  order: Order;
  due: FeedInstallment | null;
}): React.ReactElement {
  const first = order.items[0];
  const extra = order.items.length - 1;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.order_number}, ${ghs(order.total_pesewas)}`}
      onPress={() => router.push(`/orders/${order.id}`)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card bare>
        <View style={styles.cardHead}>
          <Text variant="eyebrow" tone="faint">
            {order.order_number}
          </Text>
          <OrderStatusPill status={order.status} />
        </View>

        <View style={styles.cardBody}>
          <View style={[styles.thumb, { backgroundColor: tintFor(order.id) }]} />
          <View style={styles.cardText}>
            <Text variant="smallMedium" numberOfLines={2}>
              {first?.title ?? 'Order'}
              {extra > 0 ? ` +${extra} more` : ''}
            </Text>
            <Text variant="tiny" tone="muted">
              {pluralise(order.items.length, 'item')} ·{' '}
              {order.payment_type === 'installment' ? 'paying in instalments' : 'paid in full'}
            </Text>
            <Text variant="bodyMedium">{ghs(order.total_pesewas)}</Text>
          </View>
        </View>

        {due ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ghs(due.payable_pesewas)} due ${relativeDate(due.due_date)}. Pay now.`}
            onPress={() => router.push('/plans')}
            style={[styles.strip, due.is_overdue ? styles.stripOverdue : styles.stripDue]}
          >
            <Text variant="smallMedium" tone={due.is_overdue ? 'accent' : 'ink'}>
              {ghs(due.payable_pesewas)} due {relativeDate(due.due_date)}
            </Text>
            <Text variant="smallMedium" tone="accent">
              Pay now ›
            </Text>
          </Pressable>
        ) : null}

        {!due && order.status === 'pending_payment' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Pay ${ghs(order.total_pesewas)} for order ${order.order_number}`}
            onPress={() => router.push(`/orders/${order.id}`)}
            style={[styles.strip, styles.stripDue]}
          >
            <Text variant="smallMedium">Waiting for payment</Text>
            <Text variant="smallMedium" tone="accent">
              Pay now ›
            </Text>
          </Pressable>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, gap: space.md },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  cardBody: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  thumb: { width: 58, height: 58, borderRadius: radius.sm },
  cardText: { flex: 1, gap: 2 },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  stripDue: { backgroundColor: color.surfaceSunk },
  stripOverdue: { backgroundColor: color.accentTint },
});
