import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { MerchantOrderBucket, MerchantOrderRow, OrderStatus } from '@installment/api-types';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  Loading,
  OrderStatusPill,
  Pill,
  Screen,
  Segmented,
  Text,
  isAwaitingConfirmation,
  type SegmentOption,
} from '../../src/components';
import { useConfirmOrder, useOrderCounts, useOrderQueue } from '../../src/features/merchant';
import { relativeDate } from '../../src/lib/dates';
import { cedis, ghs } from '../../src/lib/format';
import { color, font, radius, space, tintFor } from '../../src/theme/tokens';

/**
 * The chip row's value. `all` is a chip but not a bucket — the queue endpoint
 * expresses "everything" as the absence of a filter — so the two are joined
 * here and split apart again at the one place that calls the API.
 */
type QueueFilter = MerchantOrderBucket | 'all';

/**
 * The statuses on which a plan is still being collected.
 *
 * Everything a live financed order can be, and nothing a dead one can:
 * `declined`, `cancelled`, `returned` and `defaulted` are all reachable with
 * `payment_type = 'installment'`, and on every one of them Ejua has stopped
 * collecting — or never started.
 */
const FINANCING_IS_LIVE: readonly OrderStatus[] = [
  'financing_active',
  'paid',
  'fulfilling',
  'shipped',
  'delivered',
  'completed',
];

const CHIPS: { value: QueueFilter; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

/**
 * An empty bucket and an empty shop are different facts and a seller reads them
 * differently: "no new orders" is the good news that nothing is waiting, and
 * "no orders yet" is a shop that has not sold anything. One string for both
 * would tell the second seller the first seller's story.
 */
const EMPTY: Record<QueueFilter, { title: string; body: string }> = {
  new: {
    title: 'No new orders',
    body: 'Nothing is waiting on you. A paid order appears here the moment it comes in.',
  },
  confirmed: {
    title: 'Nothing to send out',
    body: 'Orders you have confirmed sit here until you mark them shipped.',
  },
  shipped: {
    title: 'Nothing on its way',
    body: 'Orders you have marked shipped stay here until they reach the customer.',
  },
  delivered: {
    title: 'Nothing delivered yet',
    body: 'Delivered orders wait here while the return window runs.',
  },
  completed: {
    title: 'Nothing completed yet',
    body: 'An order completes once its return window has closed.',
  },
  all: {
    title: 'No orders yet',
    body: 'Your first order will land here as soon as a customer pays for it.',
  },
};

export default function OrdersScreen(): React.ReactElement {
  // `new` rather than `all`, because this tab is where the home screen's
  // "orders to confirm" row points and that seller arrived to do one job.
  const [filter, setFilter] = useState<QueueFilter>('new');
  const queue = useOrderQueue(filter === 'all' ? undefined : filter);
  const counts = useOrderCounts();
  const confirm = useConfirmOrder();

  // Keyed by order, not a single boolean: one hook serves every card, so a
  // global `isPending` would spin all of them at once and a global error would
  // hang one order's failure under all of them.
  const [confirming, setConfirming] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    void queue.refetch();
    void counts.refetch();
  }, [queue, counts]);

  const onConfirm = useCallback(
    (orderId: string) => {
      setConfirming((ids) => [...ids, orderId]);
      setFailures((prev) => {
        if (prev[orderId] === undefined) return prev;
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      // `mutateAsync`, NOT `mutate(vars, { onError, onSettled })`. One
      // `useMutation` call is one MutationObserver, and passing callbacks to
      // `mutate` stores them ON the observer — so a second tap overwrites the
      // first tap's callbacks and detaches it from the observer, and the first
      // order's `onSettled` never runs. Its button then spins for ever and its
      // failure is never shown, which is precisely the case the per-order
      // bookkeeping above exists for. A promise belongs to its own call.
      confirm
        .mutateAsync({ orderId })
        .catch((err: unknown) =>
          setFailures((prev) => ({
            ...prev,
            [orderId]: apiErrorMessage(err, 'Could not confirm this order.'),
          })),
        )
        .finally(() => setConfirming((ids) => ids.filter((id) => id !== orderId)));
    },
    [confirm],
  );

  const options = useMemo<SegmentOption<QueueFilter>[]>(
    // `undefined` renders no number at all, which is what the chip should show
    // both while the counts are in flight AND after the request has given up —
    // in neither case is there a count to state, and a `0` would be a claim.
    () => CHIPS.map((chip) => ({ ...chip, count: counts.data?.[chip.value] })),
    [counts.data],
  );

  const rows = queue.data?.rows ?? [];
  const empty = EMPTY[filter];
  // `total` is the count over the whole bucket; `rows` is one page of it. Saying
  // "83 in view" above 25 cards would be false, and the seller would have no way
  // to tell that the other 58 exist.
  const capped = queue.data ? queue.data.total > rows.length : false;

  // The loading and error states render without a RefreshControl: mounting one
  // already refreshing puts a second spinner above the centred one.
  if (queue.isPending) {
    return (
      <Screen tabBar>
        <QueueHeader options={options} filter={filter} onFilter={setFilter} />
        <Loading />
      </Screen>
    );
  }

  if (queue.error) {
    return (
      <Screen tabBar>
        <QueueHeader options={options} filter={filter} onFilter={setFilter} />
        <ErrorState
          message={apiErrorMessage(queue.error, 'Could not load your orders.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  return (
    <Screen tabBar refreshing={queue.isFetching || counts.isFetching} onRefresh={refresh}>
      <QueueHeader
        options={options}
        filter={filter}
        onFilter={setFilter}
        showing={rows.length}
        total={queue.data?.total}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="box" size={30} color={color.mutedSoft} />}
          title={empty.title}
          body={empty.body}
        />
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <OrderCard
              key={row.id}
              row={row}
              confirming={confirming.includes(row.id)}
              error={failures[row.id]}
              onConfirm={onConfirm}
            />
          ))}
          {capped ? (
            <Text variant="tiny" tone="faint" center style={styles.capped}>
              {`Showing the ${rows.length} most recent of ${queue.data?.total}. The rest are on the merchant portal on the web until this list can page.`}
            </Text>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

/**
 * The title and the filter chips.
 *
 * Its own component because the loading, error and loaded states all render it
 * — a seller who arrives while the queue is still fetching should still see
 * which filter they are on, and switching filters must not be gated on the
 * previous filter having loaded.
 */
function QueueHeader({
  options,
  filter,
  onFilter,
  showing,
  total,
}: {
  options: SegmentOption<QueueFilter>[];
  filter: QueueFilter;
  onFilter: (value: QueueFilter) => void;
  showing?: number;
  total?: number;
}): React.ReactElement {
  return (
    <View style={styles.top}>
      <Header
        flush
        title="Orders"
        right={
          showing === undefined || total === undefined ? null : (
            <Text variant="smallMedium" tone="muted">
              {/* What is on screen, not what the bucket holds: the two differ
                  the moment a bucket outgrows one page. */}
              {showing === total ? `${total} in view` : `${showing} of ${total}`}
            </Text>
          )
        }
      />
      <Segmented options={options} value={filter} onChange={onFilter} style={styles.chips} />
    </View>
  );
}

function OrderCard({
  row,
  confirming,
  error,
  onConfirm,
}: {
  row: MerchantOrderRow;
  confirming: boolean;
  error: string | undefined;
  onConfirm: (orderId: string) => void;
}): React.ReactElement {
  const first = row.items[0];
  const extra = row.items.length - 1;
  const summary = first
    ? extra > 0
      ? `${first.title} + ${extra} more`
      : first.title
    : 'No items on this order';
  const buyer = row.buyer_name ?? 'Customer';
  // `placed_at` is null until the order is actually placed; `created_at` is the
  // cart's own age and the only other thing there is to date it by. The word
  // changes with it — under the All filter this list contains orders that were
  // never placed, and dating those "placed" would be a small lie told often.
  const dated = relativeDate(row.placed_at ?? row.created_at);
  const datedVerb = row.placed_at ? 'placed' : 'started';
  // `null` is "the ledger has booked nothing against this order", which is not
  // the same as settling it for zero — so it gets words, not a figure.
  const settled = row.settled_pesewas;

  const spoken = [
    `Order ${row.order_number}`,
    summary,
    `for ${buyer}`,
    `${datedVerb} ${dated.toLowerCase()}`,
    `total ${ghs(row.total_pesewas)}`,
    settled === null ? 'not settled yet' : `${ghs(settled)} settled`,
  ].join('. ');

  return (
    // The card is a Card with a Pressable INSIDE it rather than a Pressable
    // wrapping the card, because "Confirm order" sits in the same card. A
    // touchable inside a touchable fires both: tapping Confirm would confirm
    // the order and navigate away from the list at the same time, so the seller
    // would never see it succeed or fail. Web says the same thing more loudly —
    // a <button> nested in a <button> is invalid HTML.
    <Card style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        onPress={() => router.push(`/orders/${row.id}`)}
        style={({ pressed }) => (pressed ? styles.pressed : null)}
      >
        <View style={styles.head}>
          <Text variant="eyebrowLg" tone="faint" numberOfLines={1} style={styles.reference}>
            {row.order_number}
          </Text>
          <OrderStatusPill status={row.status} />
        </View>

        <View style={styles.body}>
          {/* No product imagery in the queue payload, so the tile is a stable
              tint off the line's own id — a list of grey boxes reads as a
              screen that has not finished loading. */}
          <View
            style={[
              styles.thumb,
              { backgroundColor: tintFor(first?.product_id ?? first?.title ?? row.id) },
            ]}
          />
          <View style={styles.bodyText}>
            <Text variant="smallMedium" tone="soft" numberOfLines={2}>
              {summary}
            </Text>
            <Text variant="tiny" tone="muted" numberOfLines={1} style={styles.meta}>
              {`${buyer} · ${dated}`}
            </Text>
          </View>
          <View style={styles.amounts}>
            <Text style={styles.total}>{ghs(row.total_pesewas)}</Text>
            <Text
              variant="tiny"
              tone={settled === null ? 'faint' : 'primary'}
              style={styles.settled}
            >
              {settled === null ? 'Not settled yet' : `${cedis(settled)} settled`}
            </Text>
          </View>
        </View>

        {row.payment_type === 'installment' && FINANCING_IS_LIVE.includes(row.status) ? (
          <View style={styles.planInside}>
            {/* Not "PAY IN 4": the queue row carries no plan, and the number of
                instalments lives on one. The sheet, which fetches the plan, is
                where a count can honestly be printed.

                Gated on the status as well as the payment type, because the
                sentence is in the present tense. Under the All filter this list
                holds declined, cancelled and returned instalment orders, and
                "Ejua collects from the customer" printed under a DECLINED pill
                describes a collection that will never happen. */}
            <Pill label="INSTALMENTS" tone="dark" />
            <Text variant="tiny" style={styles.planNote}>
              {settled === null
                ? 'Ejua collects from the customer — nothing settled to you yet'
                : 'Ejua collects from the customer — your settlement is already booked'}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {/* Off the status, not off the bucket: the All filter shows new orders
          too, and they are just as confirmable there. Outside the Pressable
          above so a tap on it confirms and nothing else. */}
      {isAwaitingConfirmation(row.status) ? (
        <View style={styles.actions}>
          <Button
            label="Confirm order"
            variant="dark"
            compact
            loading={confirming}
            disabled={confirming}
            onPress={() => onConfirm(row.id)}
          />
          {error ? (
            <Text variant="tiny" tone="accent" center>
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  top: {
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
  },
  chips: { paddingLeft: space.lg, paddingBottom: space.md },

  list: { padding: space.lg, gap: space.md },
  pressed: { opacity: 0.9 },

  card: { gap: space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  reference: { flexShrink: 1 },

  body: { flexDirection: 'row', gap: space.md },
  thumb: { width: 56, height: 56, borderRadius: radius.md },
  bodyText: { flex: 1, justifyContent: 'center' },
  meta: { marginTop: 3 },
  amounts: { alignItems: 'flex-end', justifyContent: 'center' },
  total: { fontFamily: font.bold, fontSize: 15, letterSpacing: -0.3, color: color.ink },
  settled: { marginTop: 2 },

  planInside: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.accentTint,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  planNote: { flex: 1, color: color.accentDark },

  actions: { gap: space.sm },
  capped: { paddingHorizontal: space.lg, paddingTop: space.sm, lineHeight: 16 },
});
