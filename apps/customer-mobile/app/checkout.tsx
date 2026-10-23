import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import {
  apiErrorMessage,
  apiErrorStatus,
  newIdempotencyKey,
  useAuth,
} from '@installment/mobile-kit';
import {
  Button,
  Card,
  Chip,
  Header,
  Icon,
  Loading,
  Pill,
  ScheduleStrip,
  Screen,
  SectionLabel,
  Sheet,
  StickyFooter,
  Text,
} from '../src/components';
import {
  checkoutKey,
  useAddresses,
  useCart,
  useCheckout,
  useCreateAddress,
  usePayOrderCard,
  usePayOrderMomo,
} from '../src/features/shop';
import {
  usePayInstallmentLink,
  usePayInstallmentMomo,
  useProfile,
  useSetMomo,
} from '../src/features/account';
import { useDeliveryQuote, usePickupHubs, usePlanQuotes } from '../src/features/storefront';
import { cadence, ghs } from '../src/lib/format';
import {
  basketCost,
  commonEligibleTemplateIds,
  ordersPlanLines,
  planLines,
  shopOrders,
} from '../src/lib/basket';
import { arrivalWindow } from '../src/lib/dates';
import { DEFAULT_CITY, DEFAULT_REGION } from '../src/lib/config';
import { color, radius, space } from '../src/theme/tokens';
import type { DecidedOrder, MomoProvider, PlanQuote } from '../src/features/types';

type Fulfilment = 'courier' | 'pickup';
type PaymentChoice = 'installment' | 'full';

const FOOTER_HEIGHT = 96;

/**
 * The three networks Paystack settles Ghanaian Mobile Money through. `tgo` is
 * AirtelTigo and `vod` is Telecel (formerly Vodafone) — the provider codes are
 * the API's, the labels are what a customer calls them.
 */
const MOMO_PROVIDERS: { value: MomoProvider; label: string }[] = [
  { value: 'mtn', label: 'MTN' },
  { value: 'tgo', label: 'AirtelTigo' },
  { value: 'vod', label: 'Telecel' },
];

/** `24 000 0000` / `024 000 0000` -> `+233240000000`, which is what the API takes. */
function normaliseGhPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  const local = digits.startsWith('233') ? digits.slice(3) : digits.replace(/^0/, '');
  return `+233${local}`;
}

export default function CheckoutScreen(): React.ReactElement {
  const { signedIn } = useAuth();
  const cart = useCart(signedIn);
  const addresses = useAddresses(signedIn);
  const hubs = usePickupHubs();

  const [fulfilment, setFulfilment] = useState<Fulfilment>('courier');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [hubId, setHubId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentChoice>('installment');
  const [planId, setPlanId] = useState<string | null>(null);
  const [addressSheet, setAddressSheet] = useState(false);
  // Every order checkout made — one per shop — walked one at a time.
  const [decisions, setDecisions] = useState<DecidedOrder[] | null>(null);
  const [step, setStep] = useState(0);
  const [shopNames, setShopNames] = useState<Record<string, string>>({});
  // Typed once, used for every order's deposit.
  const [momo, setMomo] = useState<MomoDetails>({ phone: '', provider: null });
  const [error, setError] = useState<string | null>(null);

  const checkout = useCheckout();

  // Default to the customer's saved address / the first hub once they load.
  useEffect(() => {
    if (addressId || !addresses.data?.length) return;
    setAddressId((addresses.data.find((a) => a.is_default) ?? addresses.data[0])?.id ?? null);
  }, [addresses.data, addressId]);
  useEffect(() => {
    if (hubId || !hubs.data?.length) return;
    setHubId(hubs.data[0]?.id ?? null);
  }, [hubs.data, hubId]);

  const address = addresses.data?.find((a) => a.id === addressId) ?? null;
  const delivery = useDeliveryQuote({
    addressId: address?.id,
    city: address ? undefined : DEFAULT_CITY,
    region: address ? undefined : DEFAULT_REGION,
    enabled: signedIn,
  });

  const subtotal = cart.data?.subtotal_pesewas ?? 0;
  const cost = basketCost({
    subtotalPesewas: subtotal,
    storeCount: cart.data?.store_count ?? 1,
    pickup: fulfilment === 'pickup',
    feePesewas: delivery.data?.fee_pesewas,
  });
  // Null until delivery is priced; nothing below may present a total before it.
  const total = cost.totalPesewas;

  /**
   * One plan per order, as checkout will make them.
   *
   * A basket from two shops becomes two orders, each with its own plan on its
   * own amount. This quoted one plan on the combined total — a schedule and a
   * deposit the customer was never going to be given — and the sheet then
   * walked only the first order's deposit. Each shop is quoted on its own order
   * (its subtotal plus its own delivery), and only plans every order qualifies
   * for are offered, since one template is sent for all of them.
   */
  const shops = shopOrders(cart.data?.items ?? [], {
    pickup: fulfilment === 'pickup',
    feePesewas: delivery.data?.fee_pesewas,
  });
  const multiShop = shops.length > 1;
  const shopQuotes = usePlanQuotes(shops.map((shop) => shop.amountPesewas ?? 0));
  const commonIds = commonEligibleTemplateIds(shopQuotes) ?? [];
  const chosenId = planId && commonIds.includes(planId) ? planId : (commonIds[0] ?? null);
  const shopPlans = chosenId
    ? shops.map((shop, i) => ({
        shop,
        quote: shopQuotes[i]?.find((q) => q.plan_template_id === chosenId) ?? null,
      }))
    : [];
  // Every order's plan, once each is quoted — the footer speaks for all of them.
  const orderPlans = shopPlans.every((p) => p.quote) ? shopPlans.map((p) => p.quote!) : [];
  const plan = orderPlans[0] ?? null;
  const planText = plan ? ordersPlanLines(orderPlans) : null;
  const eligible = commonIds
    .map((id) => shopQuotes[0]?.find((q) => q.plan_template_id === id))
    .filter((q): q is PlanQuote => Boolean(q));

  /**
   * One idempotency key per checkout ATTEMPT, held across renders.
   *
   * A fresh key per tap would turn a timed-out checkout into a second order and
   * a second credit line. The key is rotated only when the payload changes,
   * because the server hashes (method, path, user, body) — replaying a key with
   * a different body is a 409, not a replay.
   */
  const attemptKey = useRef(checkoutKey());
  const payloadSignature = `${payment}:${plan?.plan_template_id ?? ''}:${fulfilment}:${addressId ?? ''}:${hubId ?? ''}:${total ?? ''}`;
  const lastSignature = useRef(payloadSignature);
  if (lastSignature.current !== payloadSignature) {
    lastSignature.current = payloadSignature;
    attemptKey.current = checkoutKey();
  }

  const canSubmit =
    total !== null &&
    (cart.data?.items.length ?? 0) > 0 &&
    (fulfilment === 'courier' ? Boolean(addressId) : Boolean(hubId)) &&
    (payment === 'full' || Boolean(plan));

  async function submit(): Promise<void> {
    setError(null);
    try {
      const decided = await checkout.mutateAsync({
        payment_type: payment,
        ...(payment === 'installment' && plan ? { plan_template_id: plan.plan_template_id } : {}),
        ...(fulfilment === 'courier' && addressId ? { shipping_address_id: addressId } : {}),
        fulfilment_method: fulfilment,
        ...(fulfilment === 'pickup' && hubId ? { pickup_hub_id: hubId } : {}),
        idempotencyKey: attemptKey.current,
      });
      // A multi-store basket becomes several orders; the sheet walks each.
      if (decided.length === 0) throw new Error('Checkout returned no order');
      setShopNames(Object.fromEntries(shops.map((shop) => [shop.storeId, shop.name])));
      setStep(0);
      setDecisions(decided);
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not place your order.'));
    }
  }

  /**
   * Nothing to buy — bounce rather than render an empty checkout.
   *
   * In an effect, not in the render body. `router.replace` updates the
   * navigation container's state, and doing that while React is rendering this
   * component is the "Cannot update a component while rendering a different
   * component" warning: React is midway through a render pass and a different
   * component's state changes underneath it. The redirect is a side effect of
   * the cart being empty, so it belongs where side effects go.
   */
  const cartIsEmpty = Boolean(cart.data && cart.data.items.length === 0 && !decisions);
  useEffect(() => {
    if (cartIsEmpty) router.replace('/cart');
  }, [cartIsEmpty]);

  /**
   * Off checkout once its orders are placed, to where they can be seen.
   *
   * `decisions` is deliberately left set. Checkout has emptied the cart, so
   * clearing it made `cartIsEmpty` true and the effect above fired its own
   * `router.replace('/cart')` after this one: a customer who had just paid was
   * left on an empty cart instead of their order. Several orders have no single
   * confirmation, so the order list shows them.
   */
  function leaveCheckout(placed: DecidedOrder[]): void {
    router.replace(placed.length > 1 ? '/orders' : `/confirmation/${placed[0]!.order.id}`);
  }

  if (!signedIn) {
    return (
      <Screen>
        <Header title="Checkout" back />
        <Loading />
      </Screen>
    );
  }

  if (cartIsEmpty) {
    // The redirect itself happens in the effect above — navigating here would
    // be a state update during render. Show the spinner the bounce lands on.
    return (
      <Screen>
        <Header title="Checkout" back />
        <Loading />
      </Screen>
    );
  }

  return (
    <>
      <Screen footerHeight={FOOTER_HEIGHT}>
        <Header title="Checkout" back />

        {cart.isPending ? <Loading /> : null}

        {cart.data ? (
          <View style={styles.body}>
            <SectionLabel>1 · How you get it</SectionLabel>
            <View style={styles.methodRow}>
              <MethodCard
                icon="truck"
                title="Courier"
                detail={deliveryFeeLabel(delivery.data?.fee_pesewas)}
                selected={fulfilment === 'courier'}
                onPress={() => setFulfilment('courier')}
              />
              <MethodCard
                icon="store"
                title="Pickup hub"
                detail="Collect free"
                selected={fulfilment === 'pickup'}
                onPress={() => setFulfilment('pickup')}
              />
            </View>

            {fulfilment === 'courier' ? (
              address ? (
                <Card style={styles.addressCard}>
                  <Icon name="pin" size={17} color={color.ink} />
                  <View style={styles.addressText}>
                    <Text variant="smallMedium">
                      {address.recipient} · {address.phone}
                    </Text>
                    <Text variant="tiny" tone="muted">
                      {[address.area, address.city, address.region].filter(Boolean).join(', ')}
                      {address.landmark ? ` · ${address.landmark}` : ''}
                    </Text>
                    {delivery.data ? (
                      <Text variant="tiny" tone="muted">
                        {arrivalWindow(delivery.data.eta_earliest, delivery.data.eta_latest)}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add a different delivery address"
                    onPress={() => setAddressSheet(true)}
                    hitSlop={8}
                  >
                    <Text variant="smallMedium" tone="accent">
                      Change
                    </Text>
                  </Pressable>
                </Card>
              ) : (
                <Button
                  label="Add a delivery address"
                  variant="outline"
                  onPress={() => setAddressSheet(true)}
                />
              )
            ) : (
              <Card bare>
                {(hubs.data ?? []).map((hub, index) => (
                  <Pressable
                    key={hub.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: hubId === hub.id }}
                    accessibilityLabel={`Collect from ${hub.name}. ${hub.detail ?? ''}`}
                    onPress={() => setHubId(hub.id)}
                    style={[styles.hubRow, index > 0 && styles.hubDivider]}
                  >
                    <Radio selected={hubId === hub.id} />
                    <View style={styles.hubText}>
                      <Text variant="smallMedium">{hub.name}</Text>
                      {hub.detail ? (
                        <Text variant="tiny" tone="muted">
                          {hub.detail}
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="tiny" tone="success">
                      Free
                    </Text>
                  </Pressable>
                ))}
                {hubs.data?.length === 0 ? (
                  <View style={styles.hubRow}>
                    <Text variant="small" tone="muted">
                      No collection points near you yet — choose courier delivery.
                    </Text>
                  </View>
                ) : null}
              </Card>
            )}

            <SectionLabel style={styles.sectionGap}>2 · How you pay</SectionLabel>

            {/* Every figure below is derived from the cart total, so none of it
                may render before the cart has loaded. `subtotal` falls back to 0
                while the query is in flight, which made "Pay in full" show the
                delivery fee alone — GHS 15 on a GHS 655 order — and quoted the
                instalment plan against that same GHS 15. A wrong price on the
                screen where someone commits is worse than a spinner. */}
            {cart.isPending ? <Loading /> : null}

            {!cart.isPending && plan && planText ? (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: payment === 'installment' }}
                accessibilityLabel={`${planText.lead}. ${planText.rest}.`}
                onPress={() => setPayment('installment')}
              >
                <Card style={payment === 'installment' ? styles.payCardOn : styles.payCard}>
                  <View style={styles.payHead}>
                    <Radio selected={payment === 'installment'} />
                    <View style={styles.payText}>
                      <View style={styles.payTitleRow}>
                        <Text variant="smallMedium">Pay in {plan.installments.length}</Text>
                        {/* Only when the quote's interest really is zero. */}
                        {plan.interest_rate_bps === 0 ? (
                          <Pill label="0% INTEREST" tone="success" />
                        ) : null}
                      </View>
                      <Text variant="tiny" tone="muted">
                        {multiShop
                          ? planText.rest
                          : plan.down_payment_pesewas > 0
                            ? `${ghs(plan.down_payment_pesewas)} today, ${planLines(plan).rest}`
                            : planLines(plan).rest}
                      </Text>
                    </View>
                  </View>

                  {payment === 'installment' ? (
                    <View style={styles.expanded}>
                      {eligible.length > 1 ? (
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={styles.planChips}
                        >
                          {eligible.map((q) => (
                            <Chip
                              key={q.plan_template_id}
                              label={`${q.name} · ${q.installments.length} payments`}
                              selected={q.plan_template_id === plan.plan_template_id}
                              onPress={() => setPlanId(q.plan_template_id)}
                            />
                          ))}
                        </ScrollView>
                      ) : null}
                      {multiShop ? (
                        shopPlans.map(({ shop, quote }) =>
                          quote ? (
                            <View key={shop.storeId} style={styles.shopPlan}>
                              <Text variant="smallMedium">{shop.name}</Text>
                              <Text variant="tiny" tone="muted">
                                {planLines(quote).lead}, {planLines(quote).rest}
                              </Text>
                              <ScheduleStrip installments={quote.installments} />
                            </View>
                          ) : null,
                        )
                      ) : (
                        <ScheduleStrip installments={plan.installments} />
                      )}
                      <Text variant="tiny" tone="muted">
                        Collected automatically from your Mobile Money{' '}
                        {cadence(plan.installment_frequency_days)}. You can switch that off and pay
                        by hand at any time.
                      </Text>
                    </View>
                  ) : null}
                </Card>
              </Pressable>
            ) : null}

            {!cart.isPending ? (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: payment === 'full' }}
                accessibilityLabel={`Pay ${ghs(total)} in full`}
                onPress={() => setPayment('full')}
              >
                <Card style={payment === 'full' ? styles.payCardOn : styles.payCard}>
                  <View style={styles.payHead}>
                    <Radio selected={payment === 'full'} />
                    <View style={styles.payText}>
                      <Text variant="smallMedium">Pay in full</Text>
                      <Text variant="tiny" tone="muted">
                        Mobile Money or card, in one go
                      </Text>
                    </View>
                    <Text variant="bodyMedium">{ghs(total)}</Text>
                  </View>
                </Card>
              </Pressable>
            ) : null}

            <SectionLabel style={styles.sectionGap}>3 · Order summary</SectionLabel>
            <Card style={styles.summary}>
              {cart.data.items.map((line) => (
                <View key={line.id} style={styles.summaryRow}>
                  <Text variant="small" tone="muted" style={styles.summaryLabel} numberOfLines={1}>
                    {line.title} × {line.quantity}
                  </Text>
                  <Text variant="smallMedium">{ghs(line.line_total_pesewas)}</Text>
                </View>
              ))}
              <View style={styles.rule} />
              <View style={styles.summaryRow}>
                <Text variant="small" tone="muted" style={styles.summaryLabel}>
                  Delivery
                </Text>
                <Text variant="smallMedium">
                  {cost.deliveryPesewas === null
                    ? delivery.isError
                      ? 'Not available'
                      : 'Working it out…'
                    : cost.deliveryPesewas === 0
                      ? 'Free'
                      : ghs(cost.deliveryPesewas)}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text variant="small" tone="muted" style={styles.summaryLabel}>
                  Buyer protection
                </Text>
                <Text variant="smallMedium" tone="success">
                  Free
                </Text>
              </View>
              <View style={styles.rule} />
              <View style={styles.summaryRow}>
                <Text variant="bodyMedium" style={styles.summaryLabel}>
                  Order total
                </Text>
                <Text variant="price">{ghs(total)}</Text>
              </View>
            </Card>

            {error ? (
              <Text variant="small" tone="accent">
                {error}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Screen>

      <StickyFooter>
        <Button
          label={
            payment === 'installment' && planText
              ? planText.lead
              : total === null
                ? 'Pay in full'
                : `Pay ${ghs(total)}`
          }
          sublabel={payment === 'installment' && planText ? planText.rest : undefined}
          loading={checkout.isPending}
          disabled={!canSubmit}
          onPress={() => void submit()}
        />
      </StickyFooter>

      <AddressSheet
        visible={addressSheet}
        onClose={() => setAddressSheet(false)}
        onCreated={(id) => {
          setAddressId(id);
          setAddressSheet(false);
        }}
      />

      {decisions && decisions[step] ? (
        <DecisionSheet
          // Remounted per order: fresh payment hooks and a fresh idempotency
          // key for each order's deposit, the typed number carried over.
          key={decisions[step].order.id}
          decision={decisions[step]}
          position={{
            index: step,
            count: decisions.length,
            shopName: shopNames[decisions[step].order.store_id] ?? null,
          }}
          momo={momo}
          onMomoChange={setMomo}
          onDone={() => {
            if (step < decisions.length - 1) {
              setStep(step + 1);
              return;
            }
            leaveCheckout(decisions);
          }}
          // The orders exist whether or not the sheet is walked to the end.
          onDismiss={() => leaveCheckout(decisions)}
        />
      ) : null}
    </>
  );
}

/**
 * The BNPL approval sheet.
 *
 * The decision has ALREADY been made — `POST /me/checkout` scores and activates
 * before it responds — so this renders an outcome rather than driving one. It
 * is not dismissable while a payment is in flight: a customer who swipes it
 * away mid-charge would be left not knowing whether they had just opened a
 * credit line.
 */
interface MomoDetails {
  phone: string;
  provider: MomoProvider | null;
}

function DecisionSheet({
  decision,
  position,
  momo,
  onMomoChange,
  onDone,
  onDismiss,
}: {
  decision: DecidedOrder;
  /** Which of the orders checkout made this is, and whose. */
  position: { index: number; count: number; shopName: string | null };
  momo: MomoDetails;
  onMomoChange: (next: MomoDetails) => void;
  /** This order is dealt with: the next one, or off to the confirmation. */
  onDone: () => void;
  onDismiss: () => void;
}): React.ReactElement {
  const profile = useProfile();
  const setMomoOnFile = useSetMomo();
  const payInstallment = usePayInstallmentMomo();
  const payOrder = usePayOrderMomo(decision.order.id);
  const [error, setError] = useState<string | null>(null);

  /**
   * Mobile Money details are collected HERE, not at sign-up.
   *
   * A MoMo number is payment credentials. Asking for it to open an account
   * gathers sensitive data from people who may never pay that way, and the
   * account phone is a login identity — a different thing that happens to look
   * the same. Registration therefore stores only a phone number, so there is no
   * `momo_phone` on file and the charge has to carry its own.
   */
  /** Mobile Money is a push to this handset; a card is a hosted page. */
  const [method, setMethod] = useState<'momo' | 'card'>('momo');
  const payCard = usePayOrderCard(decision.order.id);
  const payDepositLink = usePayInstallmentLink();

  const momoPhone = momo.phone;
  const momoProvider = momo.provider;
  const setMomoPhone = (phone: string): void => onMomoChange({ ...momo, phone });
  const setMomoProvider = (provider: MomoProvider): void => onMomoChange({ ...momo, provider });
  const momoReady = momoPhone.replace(/\D/g, '').length >= 9 && momoProvider !== null;

  // A separate logical attempt from the checkout, so a separate key.
  const payKey = useRef(newIdempotencyKey('deposit'));
  const busy =
    payInstallment.isPending ||
    payOrder.isPending ||
    payCard.isPending ||
    payDepositLink.isPending ||
    setMomoOnFile.isPending;

  /**
   * An approved plan with no deposit pays nothing here, so no number is ever
   * typed — and with none on file the auto-debit has nothing to collect from,
   * and the first instalment would go overdue. Ask for it now, once.
   */
  const needsCollectionNumber =
    decision.outcome === 'approved' &&
    !decision.down_payment &&
    profile.data !== undefined &&
    !profile.data.momo_phone;

  async function saveCollectionNumber(): Promise<void> {
    if (!momoProvider) return;
    setError(null);
    try {
      await setMomoOnFile.mutateAsync({
        momo_phone: normaliseGhPhone(momoPhone),
        momo_provider: momoProvider,
      });
      // The next order's sheet reads the profile to decide whether to ask again.
      await profile.refetch();
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, 'That number could not be saved.'));
    }
  }

  async function pay(): Promise<void> {
    setError(null);
    try {
      if (method === 'card') {
        // The card never reaches us. We open the provider's page, and the
        // payment settles by webhook — so success is not this call returning,
        // it is the confirmation screen's poll seeing it land. Dismissing the
        // page is not an error: nothing is paid until the customer tries again.
        //
        // A deposit is an instalment, not an order: `pay-card` refuses any
        // order not paid in full. This sent every approved plan's deposit
        // there, and the refusal (a 409) was read as "already in progress" —
        // so the customer was taken to a screen saying the deposit was paid.
        const url =
          decision.outcome === 'paid_later'
            ? (
                await payCard.mutateAsync({
                  callbackUrl: Linking.createURL('/payment-complete'),
                })
              ).authorization_url
            : decision.down_payment
              ? (await payDepositLink.mutateAsync(decision.down_payment.id)).url
              : null;
        if (!url) return;
        await WebBrowser.openAuthSessionAsync(url, Linking.createURL('/payment-complete'));
        onDone();
        return;
      }

      const charge = { phone: normaliseGhPhone(momoPhone), provider: momoProvider ?? undefined };
      if (decision.outcome === 'paid_later') {
        await payOrder.mutateAsync({ ...charge, idempotencyKey: payKey.current });
      } else if (decision.down_payment) {
        await payInstallment.mutateAsync({
          scheduleId: decision.down_payment.id,
          ...charge,
          idempotencyKey: payKey.current,
        });
      }
      onDone();
    } catch (err) {
      // On Mobile Money a 409 means a charge is already running for this row —
      // progress, not a failure, and the confirmation screen polls for the
      // outcome. On a card it means the payment was refused outright.
      if (method === 'momo' && apiErrorStatus(err) === 409) {
        onDone();
        return;
      }
      setError(apiErrorMessage(err, 'That payment did not go through.'));
    }
  }

  const approved = decision.outcome === 'approved';
  const declined = decision.outcome === 'declined';
  const review = decision.outcome === 'in_review';
  const payNow = decision.outcome === 'paid_later';
  const more = position.index < position.count - 1;

  return (
    <Sheet visible onClose={onDismiss} dark dismissable={!busy}>
      <View style={styles.sheet}>
        <View
          style={[
            styles.sheetIcon,
            { backgroundColor: declined ? color.darkHover : review ? color.warn : color.success },
          ]}
        >
          {review ? (
            <ActivityIndicator color={color.onDark} />
          ) : (
            <Icon
              name={declined ? 'x' : 'check'}
              size={22}
              color={color.onDark}
              strokeWidth={2.8}
            />
          )}
        </View>

        {position.count > 1 ? (
          <Text variant="eyebrow" tone="onDarkFaint">
            {`ORDER ${position.index + 1} OF ${position.count}`}
            {position.shopName ? ` · ${position.shopName.toUpperCase()}` : ''}
          </Text>
        ) : null}

        <Text variant="h2" tone="onDark">
          {approved
            ? 'Approved'
            : declined
              ? 'Not approved this time'
              : review
                ? 'Being reviewed'
                : 'Order placed'}
        </Text>

        {approved && decision.approved_limit_pesewas ? (
          <Text variant="small" tone="onDarkMuted">
            Using {ghs(decision.order.total_pesewas)} of your {ghs(decision.approved_limit_pesewas)}{' '}
            limit.
          </Text>
        ) : null}

        {decision.message ? (
          <Text variant="small" tone="onDarkMuted">
            {decision.message}
          </Text>
        ) : null}

        {approved && decision.down_payment ? (
          <Card dark style={styles.depositCard}>
            <View style={styles.depositRow}>
              <Text variant="small" tone="onDarkMuted">
                Pay now on Mobile Money
              </Text>
              <Text variant="h3" tone="onDark">
                {ghs(decision.down_payment.amount_due_pesewas)}
              </Text>
            </View>
            <Text variant="tiny" tone="onDarkFaint">
              The rest is collected automatically — you will see each payment before it happens.
            </Text>
          </Card>
        ) : null}

        {payNow ? (
          <Card dark style={styles.depositCard}>
            <View style={styles.depositRow}>
              <Text variant="small" tone="onDarkMuted">
                Pay now on Mobile Money
              </Text>
              <Text variant="h3" tone="onDark">
                {ghs(decision.order.total_pesewas)}
              </Text>
            </View>
          </Card>
        ) : null}

        {error ? (
          <Text variant="small" tone="accent">
            {error}
          </Text>
        ) : null}

        {(approved && decision.down_payment) || payNow ? (
          <>
            <View style={styles.payMethodRow}>
              {[
                { value: 'momo' as const, label: 'Mobile Money' },
                { value: 'card' as const, label: 'Card' },
              ].map((m) => (
                <Pressable
                  key={m.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: method === m.value }}
                  accessibilityLabel={`Pay by ${m.label}`}
                  onPress={() => setMethod(m.value)}
                  style={[styles.payMethodTab, method === m.value && styles.payMethodTabOn]}
                >
                  <Text variant="smallMedium" tone={method === m.value ? 'onDark' : 'onDarkMuted'}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {method === 'card' ? (
              <Text variant="tiny" tone="onDarkFaint">
                We will open a secure page to take your card. Your card details never reach Ejua.
              </Text>
            ) : null}

            {method === 'momo' ? (
              <MomoFields
                phone={momoPhone}
                provider={momoProvider}
                onPhone={setMomoPhone}
                onProvider={setMomoProvider}
                label="The Mobile Money number to charge"
              />
            ) : null}
            <Button
              label={method === 'card' ? 'Pay by card' : 'Approve on my phone'}
              loading={busy}
              disabled={method === 'momo' && !momoReady}
              onPress={() => void pay()}
            />
            <Text variant="tiny" tone="onDarkFaint" center>
              {method === 'card'
                ? 'You will finish on our provider’s secure page, then come back here.'
                : 'You will get a Mobile Money prompt. Enter your PIN to finish.'}
            </Text>
          </>
        ) : needsCollectionNumber ? (
          <>
            <Text variant="small" tone="onDarkMuted">
              Nothing to pay today. Which Mobile Money number should each instalment be collected
              from?
            </Text>
            <MomoFields
              phone={momoPhone}
              provider={momoProvider}
              onPhone={setMomoPhone}
              onProvider={setMomoProvider}
              label="The Mobile Money number to collect instalments from"
            />
            <Button
              label="Collect from this number"
              loading={busy}
              disabled={!momoReady}
              onPress={() => void saveCollectionNumber()}
            />
            <Button label="Not now" variant="ghost" disabled={busy} onPress={onDone} />
          </>
        ) : declined && position.count === 1 ? (
          <Button label="Keep shopping" variant="ghost" onPress={() => router.replace('/')} />
        ) : (
          <Button
            label={more ? 'Next order' : position.count > 1 ? 'See my orders' : 'See my order'}
            onPress={onDone}
          />
        )}
      </View>
    </Sheet>
  );
}

/** The number and network a Mobile Money charge or collection goes to. */
function MomoFields({
  phone,
  provider,
  onPhone,
  onProvider,
  label,
}: {
  phone: string;
  provider: MomoProvider | null;
  onPhone: (phone: string) => void;
  onProvider: (provider: MomoProvider) => void;
  /** What the number is for, read out by a screen reader. */
  label: string;
}): React.ReactElement {
  return (
    <View style={styles.momoFields}>
      <Text variant="eyebrow" tone="onDarkFaint">
        MOBILE MONEY NUMBER
      </Text>
      <View style={styles.momoRow}>
        <Text variant="bodyMedium" tone="onDarkMuted">
          +233
        </Text>
        <View style={styles.momoDivider} />
        <TextInput
          value={phone}
          onChangeText={onPhone}
          placeholder="24 000 0000"
          placeholderTextColor={color.onDarkFaint}
          keyboardType="phone-pad"
          style={styles.momoInput}
          accessibilityLabel={label}
        />
      </View>
      <View style={styles.momoProviders}>
        {MOMO_PROVIDERS.map((p) => (
          <Pressable
            key={p.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: provider === p.value }}
            accessibilityLabel={p.label}
            onPress={() => onProvider(p.value)}
            style={[styles.momoProvider, provider === p.value && styles.momoProviderOn]}
          >
            <Text variant="smallMedium" tone={provider === p.value ? 'onDark' : 'onDarkMuted'}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function AddressSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.ReactElement {
  const create = useCreateAddress();
  const [recipient, setRecipient] = useState('');
  const [phone, setPhone] = useState('');
  const [region, setRegion] = useState(DEFAULT_REGION);
  const [city, setCity] = useState(DEFAULT_CITY);
  const [area, setArea] = useState('');
  const [landmark, setLandmark] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setError(null);
    try {
      const created = await create.mutateAsync({
        recipient: recipient.trim(),
        phone: phone.trim(),
        region: region.trim(),
        city: city.trim(),
        area: area.trim() || null,
        landmark: landmark.trim() || null,
        ghanapost_gps: null,
        is_default: true,
      });
      onCreated(created.id);
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not save that address.'));
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Text variant="h3" style={styles.formTitle}>
          Delivery address
        </Text>
        <Field label="Recipient" value={recipient} onChange={setRecipient} autoCapitalize="words" />
        <Field label="Phone" value={phone} onChange={setPhone} keyboardType="phone-pad" />
        <Field label="Region" value={region} onChange={setRegion} autoCapitalize="words" />
        <Field label="City" value={city} onChange={setCity} autoCapitalize="words" />
        <Field label="Area (optional)" value={area} onChange={setArea} autoCapitalize="words" />
        <Field label="Landmark (optional)" value={landmark} onChange={setLandmark} />
        {error ? (
          <Text variant="small" tone="accent" style={styles.formError}>
            {error}
          </Text>
        ) : null}
        <Button
          label="Save address"
          loading={create.isPending}
          disabled={!recipient.trim() || !phone.trim() || !region.trim() || !city.trim()}
          onPress={() => void save()}
          style={styles.formCta}
        />
      </ScrollView>
    </Sheet>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType?: 'phone-pad';
  autoCapitalize?: 'words';
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text variant="eyebrow" tone="faint">
        {label.toUpperCase()}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        style={styles.input}
      />
    </View>
  );
}

function MethodCard({
  icon,
  title,
  detail,
  selected,
  onPress,
}: {
  icon: 'truck' | 'store';
  title: string;
  detail: string;
  selected: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={[styles.method, selected ? styles.methodOn : styles.methodOff]}
    >
      <Icon name={icon} size={20} color={color.ink} />
      <Text variant="smallMedium">{title}</Text>
      <Text variant="tiny" tone="muted">
        {detail}
      </Text>
    </Pressable>
  );
}

function Radio({ selected }: { selected: boolean }): React.ReactElement {
  return (
    <View style={[styles.radio, selected && styles.radioOn]}>
      {selected ? <View style={styles.radioDot} /> : null}
    </View>
  );
}

function deliveryFeeLabel(fee: number | undefined): string {
  if (fee === undefined) return 'To your door';
  return fee === 0 ? 'To your door · Free' : `To your door · ${ghs(fee)}`;
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  sectionGap: { marginTop: space.md },
  methodRow: { flexDirection: 'row', gap: space.md },
  method: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space.lg,
    gap: 4,
  },
  methodOn: { borderColor: color.ink, backgroundColor: color.surface },
  methodOff: { borderColor: color.border, backgroundColor: color.surfaceWarm },
  addressCard: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  addressText: { flex: 1, gap: 2 },
  hubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  hubDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  hubText: { flex: 1, gap: 2 },
  payCard: { borderColor: color.border },
  payCardOn: { borderColor: color.accent, backgroundColor: color.accentTintSoft },
  payHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  payText: { flex: 1, gap: 2 },
  payTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  expanded: { marginTop: space.lg, gap: space.md },
  planChips: { gap: space.sm },
  shopPlan: {
    gap: space.xs,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.borderSoft,
  },
  summary: { gap: space.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  summaryLabel: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginVertical: 2 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.accent },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: color.accent },
  sheet: { gap: space.md, paddingBottom: space.sm },
  sheetIcon: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payMethodRow: { flexDirection: 'row', gap: space.sm },
  payMethodTab: {
    flex: 1,
    height: 46,
    borderRadius: radius.sm,
    backgroundColor: color.darkRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  payMethodTabOn: { borderColor: color.accent, backgroundColor: color.darkHover },
  momoFields: { gap: space.sm },
  momoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    height: 54,
  },
  momoDivider: { width: 1, height: 20, backgroundColor: color.darkHover },
  momoInput: { flex: 1, color: color.onDark, fontSize: 17, fontFamily: 'Outfit_500Medium' },
  momoProviders: { flexDirection: 'row', gap: space.sm },
  momoProvider: {
    flex: 1,
    height: 42,
    borderRadius: radius.sm,
    backgroundColor: color.darkRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  momoProviderOn: { borderColor: color.accent, backgroundColor: color.darkHover },
  depositCard: { backgroundColor: color.darkRaised, gap: space.sm },
  depositRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formTitle: { marginBottom: space.lg },
  field: { gap: 6, marginBottom: space.md },
  input: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.sm,
    height: 48,
    paddingHorizontal: space.md,
    fontFamily: 'Outfit_400Regular',
    fontSize: 15,
    color: color.ink,
  },
  formError: { marginBottom: space.sm },
  formCta: { marginTop: space.sm, marginBottom: space.lg },
});
