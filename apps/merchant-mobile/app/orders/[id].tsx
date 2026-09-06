import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import type {
  InstallmentStatus,
  MerchantOrderBuyer,
  MerchantOrderDelivery,
  MerchantOrderDetail,
  MerchantOrderPlan,
  MerchantOrderSettlement,
  OrderEvent,
  OrderItem,
  OrderStatus,
} from '@installment/api-types';
import {
  Button,
  Card,
  ErrorState,
  Header,
  Line,
  Loading,
  Note,
  OrderStatusPill,
  Pill,
  PlanStatusPill,
  ScheduleStrip,
  Screen,
  StickyFooter,
  Text,
  Timeline,
  Total,
  installmentLabel,
  isAwaitingConfirmation,
  isLateInstallment,
  type ScheduleCell,
  type TimelineStep,
} from '../../src/components';
import {
  useConfirmOrder,
  useMarkDelivered,
  useMarkShipped,
  useOrderSheet,
} from '../../src/features/merchant';
import { cedis, ghs, phoneLocal } from '../../src/lib/format';
import { dateTime, dayMonth, shortDate } from '../../src/lib/dates';
import { color, font, radius, space, tintFor } from '../../src/theme/tokens';

/** Room the sticky footer needs: a 54pt button plus the bar's own padding. */
const FOOTER_HEIGHT = 86;

/** One line of small text above the button, when a transition has failed. */
const FOOTER_ERROR_HEIGHT = 28;

/**
 * The one move the seller can make from where the order stands.
 *
 * Normalised to a closure rather than passing the mutation itself around: the
 * three hooks take different bodies, so a union of them has no single callable
 * `mutate`, and the screen only ever calls them with an order id anyway.
 */
interface Transition {
  label: string;
  sublabel: string;
  run: () => void;
  pending: boolean;
  error: unknown;
  fallback: string;
}

export default function OrderSheetScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const sheet = useOrderSheet(id);
  const confirm = useConfirmOrder();
  const ship = useMarkShipped();
  const deliver = useMarkDelivered();

  // Before the pending branch: `useOrderSheet` is disabled without an id, and a
  // disabled query stays pending forever — so a missing param would otherwise
  // spin rather than say anything.
  if (!id) {
    return (
      <Screen>
        <Header title="Order" back />
        <ErrorState message="We could not find that order." />
      </Screen>
    );
  }

  if (sheet.isPending) {
    return (
      <Screen>
        <Header title="Order" back />
        <Loading />
      </Screen>
    );
  }

  if (sheet.isError || !sheet.data) {
    return (
      <Screen>
        <Header title="Order" back />
        <ErrorState
          message={apiErrorMessage(sheet.error, 'We could not load this order.')}
          onRetry={() => void sheet.refetch()}
        />
      </Screen>
    );
  }

  const order = sheet.data;
  const { buyer, delivery, plan, settlement } = order;

  const transition = transitionFor(order.status, {
    confirm: () => confirm.mutate({ orderId: id }),
    ship: () => ship.mutate({ orderId: id }),
    deliver: () => deliver.mutate({ orderId: id }),
    pending: { confirm: confirm.isPending, ship: ship.isPending, deliver: deliver.isPending },
    error: { confirm: confirm.error, ship: ship.error, deliver: deliver.error },
    returnWindowDays: order.return_window_days,
  });

  const subtitle = [order.placed_at ? dateTime(order.placed_at) : null, buyer?.name]
    .filter(Boolean)
    .join(' · ');

  const footerHeight = transition
    ? FOOTER_HEIGHT + (transition.error ? FOOTER_ERROR_HEIGHT : 0)
    : 0;

  return (
    <>
      <Screen
        footerHeight={footerHeight}
        refreshing={sheet.isRefetching}
        onRefresh={() => void sheet.refetch()}
      >
        <Header
          back
          title={order.order_number}
          subtitle={subtitle || undefined}
          right={<OrderStatusPill status={order.status} />}
        />

        <View style={styles.body}>
          {order.items.length > 0 ? (
            <Card bare style={styles.items}>
              {order.items.map((item, i) => (
                <ItemRow key={item.id} item={item} divided={i > 0} />
              ))}
            </Card>
          ) : null}

          <SettlementCard settlement={settlement} order={order} />

          {plan ? <PlanCard plan={plan} /> : null}

          {order.events.length > 0 ? (
            <Card>
              <Text variant="eyebrow" tone="faint" style={styles.eyebrow}>
                TIMELINE
              </Text>
              <Timeline steps={timelineSteps(order.events, order.status)} />
            </Card>
          ) : null}

          <DeliveryCard delivery={delivery} buyer={buyer} />
        </View>
      </Screen>

      {transition ? (
        <StickyFooter>
          {transition.error ? (
            <Text variant="small" tone="accent" style={styles.footerNote}>
              {apiErrorMessage(transition.error, transition.fallback)}
            </Text>
          ) : null}
          <Button
            label={transition.label}
            sublabel={transition.sublabel}
            loading={transition.pending}
            disabled={transition.pending}
            onPress={transition.run}
          />
        </StickyFooter>
      ) : null}
    </>
  );
}

/**
 * What the footer offers, from the order's own status.
 *
 * `paid` and `financing_active` are one case: an order is the seller's the
 * moment it is paid for, however it was paid for. Everything past `shipped` is
 * either the buyer's return window or the engine's, so there is no button —
 * rather than a greyed one that says nothing is left to do.
 */
function transitionFor(
  status: OrderStatus,
  ctx: {
    confirm: () => void;
    ship: () => void;
    deliver: () => void;
    pending: { confirm: boolean; ship: boolean; deliver: boolean };
    error: { confirm: unknown; ship: unknown; deliver: unknown };
    returnWindowDays: number;
  },
): Transition | null {
  if (isAwaitingConfirmation(status)) {
    return {
      label: 'Confirm order',
      sublabel: 'Tells the customer you are packing it',
      run: ctx.confirm,
      pending: ctx.pending.confirm,
      error: ctx.error.confirm,
      fallback: 'We could not confirm this order just now.',
    };
  }
  if (status === 'fulfilling') {
    return {
      label: 'Mark shipped',
      sublabel: 'Tells the customer it has left you',
      run: ctx.ship,
      pending: ctx.pending.ship,
      error: ctx.error.ship,
      fallback: 'We could not mark this order shipped just now.',
    };
  }
  if (status === 'shipped') {
    return {
      label: 'Mark delivered',
      sublabel:
        ctx.returnWindowDays > 0
          ? `Starts the ${ctx.returnWindowDays}-day return window`
          : 'Closes your side of the order',
      run: ctx.deliver,
      pending: ctx.pending.deliver,
      error: ctx.error.deliver,
      fallback: 'We could not mark this order delivered just now.',
    };
  }
  return null;
}

function ItemRow({ item, divided }: { item: OrderItem; divided: boolean }): React.ReactElement {
  return (
    <View style={[styles.item, divided && styles.itemDivided]}>
      <View style={[styles.swatch, { backgroundColor: tintFor(item.product_id ?? item.sku) }]} />
      <View style={styles.itemText}>
        <Text variant="smallMedium" numberOfLines={2}>
          {item.title}
        </Text>
        {/* No variant options: `order_items` snapshots title, sku, quantity and
            prices, and never the option values the canvas prints here. */}
        <Text variant="tiny" tone="faint" style={styles.itemMeta}>
          {`${item.sku} · qty ${item.quantity}`}
        </Text>
      </View>
      <Text style={styles.itemValue}>{ghs(item.line_total_pesewas)}</Text>
    </View>
  );
}

/**
 * What the ledger booked against this order.
 *
 * Every figure is read, none is computed: the fee and the reserve are whatever
 * the settlement engine actually posted, and the rate beside each is the one
 * frozen onto the plan or the order — which is not the merchant's default rate
 * and, on a staged model, not necessarily the rate that produced the figure
 * next to it. The label says "so far" for exactly that reason.
 *
 * The service nets debits against credits, so a refunded or returned order
 * reports what the seller is actually left with rather than the original
 * credit. A net at or below zero therefore means the settlement was reversed,
 * and the card says so instead of rendering a payout that is not there.
 */
function SettlementCard({
  settlement,
  order,
}: {
  settlement: MerchantOrderSettlement;
  order: MerchantOrderDetail;
}): React.ReactElement {
  const { bookedAt } = settlement;
  const feeLabel = settlement.feeLabel === 'mdr' ? 'Ejua MDR' : 'Marketplace commission';
  // Booked, then taken back. `netPesewas` is a signed net over the whole
  // transaction, so a reversal drives it to zero (or below, once a fee that was
  // never refunded is netted off).
  const reversed = bookedAt !== null && settlement.netPesewas <= 0;

  return (
    <Card>
      <Text variant="eyebrow" tone="faint" style={styles.eyebrow}>
        SETTLEMENT
      </Text>

      {bookedAt === null ? (
        // A null `bookedAt` is no settlement at all, not a settlement of zero —
        // so there is nothing to break down and a row of dashes would only look
        // like money that went missing.
        <Text variant="small" tone="muted">
          Nothing has been booked to your ledger for this order yet. The breakdown appears here once
          it settles.
        </Text>
      ) : reversed ? (
        <Text variant="small" tone="muted">
          {`This order settled and was then reversed. Nothing from it is payable to you${
            order.status === 'returned' ? ' — the return was approved' : ''
          }.`}
        </Text>
      ) : (
        <>
          {/* The lines have to add up to the total the seller is looking at.
              `order_items` sums to the SUBTOTAL; delivery and any discount sit
              between that and `total_pesewas`, so leaving them out would print
              a breakdown that does not reconcile with the items above it.
              Shown only when there IS something between the two — on a pickup
              order with no discount "Items" and "Order total" are the same
              figure twice, which reads as an error rather than as arithmetic. */}
          {order.shipping_pesewas > 0 || order.discount_pesewas > 0 ? (
            <>
              <Line label="Items" value={ghs(order.subtotal_pesewas)} />
              {order.shipping_pesewas > 0 ? (
                <Line label="Delivery" value={ghs(order.shipping_pesewas)} />
              ) : null}
              {order.discount_pesewas > 0 ? (
                <Line label="Discount" value={`−${ghs(order.discount_pesewas)}`} deduction />
              ) : null}
            </>
          ) : null}
          <Line label="Order total" value={ghs(settlement.grossPesewas)} strong />
          <Line
            label={feeLabel}
            qualifier={ratePct(settlement.feeBps)}
            value={`−${ghs(settlement.feePesewas)}`}
            deduction
          />
          {settlement.reservePesewas > 0 ? (
            <Line
              label="Reserve held"
              qualifier={ratePct(settlement.reserveBps)}
              value={`−${ghs(settlement.reservePesewas)}`}
              deduction
            />
          ) : null}
          {/* When it was booked, and no claim about when it lands. Nothing in
              this payload says whether a payout run has already carried it, so
              "in the next payout run" would be a guess on an older order. */}
          <Total
            label="Paid to you so far"
            sub={`First booked ${shortDate(bookedAt)}`}
            value={ghs(settlement.netPesewas)}
          />
        </>
      )}

      {settlement.reserveOutstandingPesewas > 0 ? (
        <View style={styles.reserve}>
          <Note eyebrow="Reserve" tone="warn">
            {`${ghs(settlement.reserveOutstandingPesewas)} is still held against this order. ${
              settlement.reserveReleasesAt
                ? `It becomes releasable from ${shortDate(settlement.reserveReleasesAt)}.`
                : 'It is held until the plan completes — the release clock only starts then.'
            }`}
          </Note>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * The credit plan behind a financed order.
 *
 * The count is `installments.length`, which includes the deposit row where the
 * plan has one; `number_of_installments` on the plan excludes it and would be
 * one short of the chips drawn below.
 */
function PlanCard({ plan }: { plan: MerchantOrderPlan }): React.ReactElement {
  const cells: ScheduleCell[] = plan.installments.map((row) => ({
    // The canvas labels these DOWN / WK 1 / WK 2, and this payload supports
    // neither half of that: there is no instalment `kind` or down-payment
    // amount to say whether the first row is a deposit (a plan written at
    // 0 bps down has none), and no frequency to say the rest are weekly rather
    // than fortnightly. The due date is the one thing the row actually states.
    label: dayMonth(row.due_date),
    amount: cedis(row.amount_due_pesewas),
    state: installmentLabel(row.status).label,
    tone: cellTone(row.status),
  }));

  return (
    <Card>
      <View style={styles.planHead}>
        <Text variant="h3" style={styles.planTitle}>
          {`Customer is paying in ${plan.installments.length}`}
        </Text>
        <PlanStatusPill status={plan.status} late={plan.late} />
      </View>

      <Pill label="EJUA IS THE LENDER" tone="accent" style={styles.planPill} />

      {/* Deliberately says nothing about WHEN the seller is credited.
          `MODEL_CONFIG` stages the payout differently per business model —
          bnpl and rent_to_own pay the whole order at approval, layaway pays it
          all at completion, hybrid splits 40/60 across the deposit and
          completion — so "you were credited when the plan was approved" is
          false for half of them, and on a layaway order it would contradict
          the settlement card directly above. What holds for every model is the
          risk: Ejua lends, Ejua collects, and an arrear never claws back what
          has already been credited. The settlement card is the single place
          that states the money, because it reads the ledger. */}
      <Text variant="small" tone="soft" style={styles.planBody}>
        Ejua lends the customer the money, collects every payment and carries the risk. What has
        been credited to you is above, and a payment the customer misses does not claw it back.
      </Text>

      <View style={styles.strip}>
        <ScheduleStrip cells={cells} />
      </View>

      <Line
        label="Collected from the customer"
        qualifier={`${plan.paidCount} of ${plan.installments.length} paid`}
        value={`${cedis(plan.collectedPesewas)} of ${ghs(plan.total_payable_pesewas)}`}
      />
    </Card>
  );
}

function DeliveryCard({
  delivery,
  buyer,
}: {
  delivery: MerchantOrderDelivery;
  buyer: MerchantOrderBuyer | null;
}): React.ReactElement {
  const pickup = delivery.method === 'pickup';

  const head = pickup
    ? delivery.hub_name
    : [delivery.recipient, delivery.phone ? phoneLocal(delivery.phone) : null]
        .filter(Boolean)
        .join(' · ');

  const lines = (
    pickup
      ? [delivery.hub_detail, join([delivery.city, delivery.region], ', ')]
      : [
          join([delivery.area, delivery.city, delivery.region], ', '),
          delivery.landmark ? `Near ${delivery.landmark}` : null,
          delivery.ghanapost_gps ? `GPS ${delivery.ghanapost_gps}` : null,
        ]
  ).filter((line): line is string => Boolean(line));

  return (
    <Card>
      <Text variant="eyebrow" tone="faint" style={styles.eyebrow}>
        {pickup ? 'COLLECTION POINT' : 'DELIVER TO'}
      </Text>

      {head || lines.length > 0 ? (
        <>
          {head ? <Text variant="smallMedium">{head}</Text> : null}
          {lines.map((line, i) => (
            <Text key={`${i}-${line}`} variant="small" tone="muted" style={styles.addressLine}>
              {line}
            </Text>
          ))}
        </>
      ) : (
        // `shipping_address_id` is ON DELETE SET NULL, so an order can outlive
        // its address. Saying so beats an empty block that reads as a bug.
        <Text variant="small" tone="muted">
          {pickup
            ? 'No collection point is recorded on this order.'
            : 'No delivery address is recorded on this order.'}
        </Text>
      )}

      {buyer ? (
        <Text variant="tiny" tone="faint" style={styles.buyer}>
          {`Buyer · ${buyer.name} · ${phoneLocal(buyer.phone)}`}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The order's own history, and nothing else.
 *
 * The payload carries no forward-looking rows, so the canvas's greyed-out
 * future steps have nothing behind them. What is left is honest: every event
 * that exists has happened, and the last one is marked `current` when the order
 * is sitting where the seller has to move it.
 */
function timelineSteps(events: OrderEvent[], status: OrderStatus): TimelineStep[] {
  const waiting = awaitsSeller(status);
  return events.map((event, i) => ({
    title: event.label,
    body: [event.detail, dateTime(event.occurred_at)].filter(Boolean).join(' · '),
    state: waiting && i === events.length - 1 ? 'current' : 'done',
  }));
}

/** The statuses whose next move is the seller's — the same set the footer acts on. */
function awaitsSeller(status: OrderStatus): boolean {
  return isAwaitingConfirmation(status) || status === 'fulfilling' || status === 'shipped';
}

/** How a schedule row is drawn. Only `done` and `late` are tinted by the strip. */
function cellTone(status: InstallmentStatus): ScheduleCell['tone'] {
  if (status === 'paid') return 'done';
  if (isLateInstallment(status)) return 'late';
  if (status === 'due' || status === 'processing') return 'due';
  return 'future';
}

/**
 * `500` → `5%`. Basis points are hundredths of a percent, so the divisor is
 * 100 and not 10,000. `null` where the rate was never recorded on the plan or
 * the order, in which case there is no rate to print beside the amount.
 */
function ratePct(bps: number | null): string | undefined {
  return bps === null ? undefined : `${bps / 100}%`;
}

function join(parts: (string | null)[], separator: string): string {
  return parts.filter(Boolean).join(separator);
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  eyebrow: { marginBottom: space.md },

  items: { paddingHorizontal: space.lg },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  itemDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  swatch: { width: 46, height: 46, borderRadius: radius.sm },
  itemText: { flex: 1 },
  itemMeta: { marginTop: 2 },
  itemValue: { fontFamily: font.bold, fontSize: 14.5, color: color.ink, letterSpacing: -0.2 },

  reserve: { marginTop: space.md },

  planHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  planTitle: { flex: 1 },
  planPill: { marginTop: space.sm },
  planBody: { marginTop: space.sm },
  strip: { marginTop: space.lg, marginBottom: space.sm },

  addressLine: { marginTop: 2 },
  buyer: { marginTop: space.md },

  footerNote: { marginBottom: space.sm },
});
