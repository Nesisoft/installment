import React from 'react';
import { Image } from 'expo-image';
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
  Pill,
  Screen,
  StickyFooter,
  Text,
} from '../../src/components';
import { useCart, useRemoveCartItem, useSetCartQuantity } from '../../src/features/shop';
import { useAddresses } from '../../src/features/shop';
import { bestQuote, useDeliveryQuote, usePlanQuote } from '../../src/features/storefront';
import { ghs, pluralise } from '../../src/lib/format';
import { basketCost, planLines } from '../../src/lib/basket';
import { DEFAULT_CITY, DEFAULT_REGION } from '../../src/lib/config';
import { color, fillParent, radius, space, tintFor } from '../../src/theme/tokens';
import type { CartLine } from '../../src/features/types';

const FOOTER_HEIGHT = 92;

export default function CartScreen(): React.ReactElement {
  const { signedIn } = useAuth();
  const cart = useCart(signedIn);
  const addresses = useAddresses(signedIn);

  const defaultAddress = addresses.data?.find((a) => a.is_default) ?? addresses.data?.[0];
  const delivery = useDeliveryQuote({
    addressId: defaultAddress?.id,
    city: defaultAddress ? undefined : DEFAULT_CITY,
    region: defaultAddress ? undefined : DEFAULT_REGION,
    enabled: signedIn,
  });

  const subtotal = cart.data?.subtotal_pesewas ?? 0;
  const storeCount = cart.data?.store_count ?? 1;
  const cost = basketCost({
    subtotalPesewas: subtotal,
    storeCount,
    pickup: false,
    feePesewas: delivery.data?.fee_pesewas,
  });

  // Quoted only once the total is known: a plan priced without its delivery
  // fee is a schedule the customer will not actually be given.
  const quotes = usePlanQuote(cost.totalPesewas ?? 0);
  const plan = bestQuote(quotes.data);

  // Checkout re-checks purchasability and rolls the WHOLE basket back on one
  // dead line, so the customer has to be able to see and fix it here.
  const blocked = (cart.data?.items ?? []).some((line) => !line.purchasable);

  if (!signedIn) {
    return (
      <Screen tabBar>
        <Header title="Cart" />
        <EmptyState
          icon={<Icon name="bag" size={30} color={color.mutedSoft} />}
          title="Sign in to start a basket"
          body="Your cart follows you between devices once you have an account."
          action={<Button label="Sign in" onPress={() => router.push('/onboarding')} />}
        />
      </Screen>
    );
  }

  const items = cart.data?.items ?? [];
  const multiStore = (cart.data?.store_count ?? 0) > 1;

  return (
    <>
      <Screen
        tabBar
        footerHeight={items.length > 0 ? FOOTER_HEIGHT : 0}
        refreshing={cart.isRefetching}
        onRefresh={() => void cart.refetch()}
      >
        <Header
          title="Cart"
          subtitle={
            cart.data && cart.data.item_count > 0
              ? pluralise(cart.data.item_count, 'item')
              : undefined
          }
        />

        {cart.isPending ? <Loading /> : null}
        {cart.isError ? (
          <ErrorState message="We couldn't load your basket." onRetry={() => void cart.refetch()} />
        ) : null}

        {cart.data && items.length === 0 ? (
          <EmptyState
            icon={<Icon name="bag" size={30} color={color.mutedSoft} />}
            title="Your cart is empty"
            body="Everything over GHS 100 can be split into instalments."
            action={<Button label="Start shopping" onPress={() => router.push('/')} />}
          />
        ) : null}

        {items.length > 0 ? (
          <View style={styles.body}>
            {multiStore ? (
              // Checkout genuinely splits one order per store. Saying so here is
              // better than the customer discovering it on the confirmation
              // screen with three order numbers they did not expect.
              <View style={styles.splitNotice}>
                <Icon name="store" size={15} color={color.warn} />
                <Text variant="tiny" tone="warn" style={styles.splitText}>
                  Your basket covers {cart.data?.store_count} shops, so it becomes{' '}
                  {cart.data?.store_count} separate orders — each delivered and paid for on its own.
                </Text>
              </View>
            ) : null}

            {groupByStore(items).map(([storeName, lines]) => (
              <View key={storeName} style={styles.group}>
                {multiStore ? (
                  <Text variant="eyebrow" tone="faint" style={styles.groupHead}>
                    {storeName.toUpperCase()}
                  </Text>
                ) : null}
                {lines.map((line) => (
                  <CartRow key={line.id} line={line} />
                ))}
              </View>
            ))}

            <Card style={styles.summary}>
              <SummaryRow label="Subtotal" value={ghs(subtotal)} />
              <SummaryRow
                label={`Delivery to ${defaultAddress?.city ?? DEFAULT_CITY}${storeCount > 1 ? ` · ${storeCount} orders` : ''}`}
                value={
                  cost.deliveryPesewas === null
                    ? delivery.isError
                      ? 'Not available'
                      : 'Working it out…'
                    : cost.deliveryPesewas === 0
                      ? 'Free'
                      : ghs(cost.deliveryPesewas)
                }
              />
              <View style={styles.rule} />
              <SummaryRow label="Total" value={ghs(cost.totalPesewas)} strong />

              {plan ? (
                <View style={styles.planNote}>
                  <Text variant="smallMedium" tone="accent">
                    Or {lowerFirst(planLines(plan).lead)}
                  </Text>
                  <Text variant="tiny" tone="muted">
                    {planLines(plan).rest}
                    {plan.interest_rate_bps === 0 ? ' — no interest' : ''}
                  </Text>
                </View>
              ) : null}
            </Card>
          </View>
        ) : null}
      </Screen>

      {items.length > 0 ? (
        <StickyFooter>
          <Button
            label={
              blocked
                ? 'Remove unavailable items to continue'
                : cost.totalPesewas === null
                  ? 'Checkout'
                  : `Checkout · ${ghs(cost.totalPesewas)}`
            }
            disabled={blocked}
            onPress={() => router.push('/checkout')}
          />
        </StickyFooter>
      ) : null}
    </>
  );
}

function CartRow({ line }: { line: CartLine }): React.ReactElement {
  const setQuantity = useSetCartQuantity();
  const remove = useRemoveCartItem();
  const busy = setQuantity.isPending || remove.isPending;

  const options = Object.entries(line.option_values)
    .map(([key, value]) => `${titleCase(key)}: ${String(value)}`)
    .join(' · ');

  return (
    <Card style={[styles.row, !line.purchasable && styles.rowDead]}>
      <View style={[styles.thumb, { backgroundColor: tintFor(line.variant_id) }]}>
        {line.image_url ? (
          <Image source={{ uri: line.image_url }} style={fillParent} contentFit="cover" />
        ) : null}
      </View>

      <View style={styles.rowBody}>
        {line.store_display_name ? (
          <Text variant="eyebrow" tone="faint" numberOfLines={1}>
            {line.store_display_name.toUpperCase()}
          </Text>
        ) : null}
        <Text variant="smallMedium" numberOfLines={2}>
          {line.title}
        </Text>
        {options ? (
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {options}
          </Text>
        ) : null}

        {line.purchasable ? (
          <View style={styles.rowFoot}>
            <Text variant="bodyMedium">{ghs(line.line_total_pesewas)}</Text>
            <View style={styles.stepper}>
              <StepperButton
                icon="minus"
                label={`Reduce quantity of ${line.title}`}
                disabled={busy}
                onPress={() =>
                  line.quantity === 1
                    ? remove.mutate(line.variant_id)
                    : setQuantity.mutate({
                        variantId: line.variant_id,
                        quantity: line.quantity - 1,
                      })
                }
              />
              <Text variant="smallMedium" style={styles.qty}>
                {line.quantity}
              </Text>
              <StepperButton
                icon="plus"
                label={`Increase quantity of ${line.title}`}
                // Stopping at the shelf here beats a 409 at checkout that rolls
                // the entire basket back.
                disabled={busy || line.quantity >= line.quantity_available}
                onPress={() =>
                  setQuantity.mutate({
                    variantId: line.variant_id,
                    quantity: line.quantity + 1,
                  })
                }
              />
            </View>
          </View>
        ) : (
          <View style={styles.rowFoot}>
            <Pill label="NO LONGER AVAILABLE" tone="neutral" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${line.title} from your basket`}
              onPress={() => remove.mutate(line.variant_id)}
              hitSlop={8}
            >
              <Text variant="smallMedium" tone="accent">
                Remove
              </Text>
            </Pressable>
          </View>
        )}

        {line.purchasable && line.quantity >= line.quantity_available ? (
          <Text variant="tiny" tone="muted">
            {line.quantity_available === 0
              ? 'Out of stock'
              : `Only ${pluralise(line.quantity_available, 'left', 'left')}`}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

function StepperButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: 'plus' | 'minus';
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={8}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.stepButton, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={icon} size={13} color={color.ink} />
    </Pressable>
  );
}

function SummaryRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.summaryRow}>
      <Text variant={strong ? 'bodyMedium' : 'small'} tone={strong ? 'ink' : 'muted'}>
        {label}
      </Text>
      <Text variant={strong ? 'price' : 'smallMedium'}>{value}</Text>
    </View>
  );
}

/** Group lines by store, preserving the order they were added in. */
function groupByStore(lines: CartLine[]): [string, CartLine[]][] {
  const groups = new Map<string, CartLine[]>();
  for (const line of lines) {
    const key = line.store_display_name ?? 'Other items';
    const bucket = groups.get(key);
    if (bucket) bucket.push(line);
    else groups.set(key, [line]);
  }
  return [...groups.entries()];
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  splitNotice: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: color.warnTint,
    borderRadius: radius.sm,
    padding: space.md,
  },
  splitText: { flex: 1 },
  group: { gap: space.sm },
  groupHead: { marginTop: space.sm },
  row: { flexDirection: 'row', gap: space.md, padding: space.md },
  rowDead: { opacity: 0.6 },
  thumb: { width: 74, height: 74, borderRadius: radius.sm, overflow: 'hidden' },
  rowBody: { flex: 1, gap: 3 },
  rowFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.pill,
    paddingHorizontal: 4,
  },
  stepButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  qty: { minWidth: 18, textAlign: 'center' },
  summary: { gap: space.sm, marginTop: space.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginVertical: 2 },
  planNote: {
    backgroundColor: color.accentTintSoft,
    borderRadius: radius.sm,
    padding: space.md,
    marginTop: space.sm,
    gap: 2,
  },
});

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
