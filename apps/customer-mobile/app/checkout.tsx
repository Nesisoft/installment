import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { usePayInstallmentMomo } from '../src/features/account';
import { useDeliveryQuote, usePickupHubs, usePlanQuote } from '../src/features/storefront';
import { cadence, ghs } from '../src/lib/format';
import { arrivalWindow } from '../src/lib/dates';
import { DEFAULT_CITY, DEFAULT_REGION } from '../src/lib/config';
import { color, radius, space } from '../src/theme/tokens';
import type { DecidedOrder, MomoProvider } from '../src/features/types';

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
  const [decision, setDecision] = useState<DecidedOrder | null>(null);
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
  const deliveryFee = fulfilment === 'pickup' ? 0 : (delivery.data?.fee_pesewas ?? 0);
  const total = subtotal + deliveryFee;

  const quotes = usePlanQuote(total);
  const eligible = useMemo(() => (quotes.data ?? []).filter((q) => q.eligible), [quotes.data]);
  const plan = eligible.find((q) => q.plan_template_id === planId) ?? eligible[0] ?? null;

  /**
   * One idempotency key per checkout ATTEMPT, held across renders.
   *
   * A fresh key per tap would turn a timed-out checkout into a second order and
   * a second credit line. The key is rotated only when the payload changes,
   * because the server hashes (method, path, user, body) — replaying a key with
   * a different body is a 409, not a replay.
   */
  const attemptKey = useRef(checkoutKey());
  const payloadSignature = `${payment}:${plan?.plan_template_id ?? ''}:${fulfilment}:${addressId ?? ''}:${hubId ?? ''}:${total}`;
  const lastSignature = useRef(payloadSignature);
  if (lastSignature.current !== payloadSignature) {
    lastSignature.current = payloadSignature;
    attemptKey.current = checkoutKey();
  }

  const canSubmit =
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
      // A multi-store basket becomes several orders; the sheet walks the first
      // and the rest are visible under Orders.
      const first = decided[0];
      if (!first) throw new Error('Checkout returned no order');
      setDecision(first);
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
  const cartIsEmpty = Boolean(cart.data && cart.data.items.length === 0 && !decision);
  useEffect(() => {
    if (cartIsEmpty) router.replace('/cart');
  }, [cartIsEmpty]);

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

            {!cart.isPending && plan ? (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: payment === 'installment' }}
                accessibilityLabel={`Pay in ${plan.installments.length}. ${ghs(plan.down_payment_pesewas)} today.`}
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
                        {ghs(plan.down_payment_pesewas)} today, then {plan.number_of_installments} ×{' '}
                        {ghs(plan.per_installment_pesewas)}{' '}
                        {cadence(plan.installment_frequency_days)}
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
                      <ScheduleStrip installments={plan.installments} />
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
                accessibilityLabel={`Pay ${ghs(total)} in full on Mobile Money`}
                onPress={() => setPayment('full')}
              >
                <Card style={payment === 'full' ? styles.payCardOn : styles.payCard}>
                  <View style={styles.payHead}>
                    <Radio selected={payment === 'full'} />
                    <View style={styles.payText}>
                      <Text variant="smallMedium">Pay in full · Mobile Money</Text>
                      <Text variant="tiny" tone="muted">
                        One prompt on your phone
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
                <Text variant="smallMedium">{deliveryFee === 0 ? 'Free' : ghs(deliveryFee)}</Text>
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
            payment === 'installment' && plan
              ? `Pay ${ghs(plan.down_payment_pesewas)} today`
              : `Pay ${ghs(total)} on Mobile Money`
          }
          sublabel={
            payment === 'installment' && plan
              ? `then ${plan.number_of_installments} × ${ghs(plan.per_installment_pesewas)} ${cadence(plan.installment_frequency_days)}`
              : undefined
          }
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

      {decision ? <DecisionSheet decision={decision} onDismiss={() => setDecision(null)} /> : null}
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
function DecisionSheet({
  decision,
  onDismiss,
}: {
  decision: DecidedOrder;
  onDismiss: () => void;
}): React.ReactElement {
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

  const [momoPhone, setMomoPhone] = useState('');
  const [momoProvider, setMomoProvider] = useState<MomoProvider | null>(null);
  const momoReady = momoPhone.replace(/\D/g, '').length >= 9 && momoProvider !== null;

  // A separate logical attempt from the checkout, so a separate key.
  const payKey = useRef(newIdempotencyKey('deposit'));
  const busy = payInstallment.isPending || payOrder.isPending || payCard.isPending;

  function toConfirmation(): void {
    onDismiss();
    router.replace(`/confirmation/${decision.order.id}`);
  }

  async function pay(): Promise<void> {
    setError(null);
    try {
      if (method === 'card') {
        // The card never reaches us. We open the provider's page, and the order
        // settles by webhook — so success is not this call returning, it is the
        // confirmation screen's poll seeing the order turn paid. Which also
        // means dismissing the page is not an error: the order simply stays
        // unpaid until the customer tries again or the TTL sweep cancels it.
        const session = await payCard.mutateAsync({
          callbackUrl: Linking.createURL('/payment-complete'),
        });
        await WebBrowser.openAuthSessionAsync(
          session.authorization_url,
          Linking.createURL('/payment-complete'),
        );
        toConfirmation();
        return;
      }

      const momo = { phone: normaliseGhPhone(momoPhone), provider: momoProvider ?? undefined };
      if (decision.outcome === 'paid_later') {
        await payOrder.mutateAsync({ ...momo, idempotencyKey: payKey.current });
      } else if (decision.down_payment) {
        await payInstallment.mutateAsync({
          scheduleId: decision.down_payment.id,
          ...momo,
          idempotencyKey: payKey.current,
        });
      }
      toConfirmation();
    } catch (err) {
      // 409 means a charge is already running for this row — that is progress,
      // not a failure, and the confirmation screen polls for the outcome.
      if (apiErrorStatus(err) === 409) {
        toConfirmation();
        return;
      }
      setError(apiErrorMessage(err, 'That payment did not go through.'));
    }
  }

  const approved = decision.outcome === 'approved';
  const declined = decision.outcome === 'declined';
  const review = decision.outcome === 'in_review';
  const payNow = decision.outcome === 'paid_later';

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
                    value={momoPhone}
                    onChangeText={setMomoPhone}
                    placeholder="24 000 0000"
                    placeholderTextColor={color.onDarkFaint}
                    keyboardType="phone-pad"
                    style={styles.momoInput}
                    accessibilityLabel="The Mobile Money number to charge"
                  />
                </View>
                <View style={styles.momoProviders}>
                  {MOMO_PROVIDERS.map((p) => (
                    <Pressable
                      key={p.value}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: momoProvider === p.value }}
                      accessibilityLabel={p.label}
                      onPress={() => setMomoProvider(p.value)}
                      style={[
                        styles.momoProvider,
                        momoProvider === p.value && styles.momoProviderOn,
                      ]}
                    >
                      <Text
                        variant="smallMedium"
                        tone={momoProvider === p.value ? 'onDark' : 'onDarkMuted'}
                      >
                        {p.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
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
        ) : declined ? (
          <Button
            label="Keep shopping"
            variant="ghost"
            onPress={() => {
              onDismiss();
              router.replace('/');
            }}
          />
        ) : (
          <Button label="See my order" onPress={toConfirmation} />
        )}
      </View>
    </Sheet>
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
