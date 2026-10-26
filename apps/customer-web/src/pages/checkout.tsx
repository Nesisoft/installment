import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  cn,
} from '@installment/ui';
import {
  checkoutSchema,
  createAddressSchema,
  formatGhs,
  type DecidedOrder,
  type PlanQuote,
} from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey } from '@installment/web-kit';
import { Check, MapPin, Plus } from 'lucide-react';
import {
  useAddresses,
  useCart,
  useCheckout,
  useCreateAddress,
  useDeliveryQuote,
  usePlanQuotes,
} from '../lib/shop-api';
import { cadenceLabel } from '../lib/installment-preview';
import { commonEligibleTemplateIds, noPlanReason, shopOrders } from '../lib/basket';
import { formatDate } from '../lib/format';
import { ErrorState, LoadingState } from '../components/data-states';

type PaymentType = 'full' | 'installment';

export function CheckoutPage() {
  const navigate = useNavigate();
  const cart = useCart();
  const addresses = useAddresses();
  const createAddress = useCreateAddress();
  const checkout = useCheckout();

  const [addressId, setAddressId] = useState<string | null>(null);
  const [paymentType, setPaymentType] = useState<PaymentType>('installment');
  const [planId, setPlanId] = useState<string | null>(null);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [form, setForm] = useState({
    recipient: '',
    phone: '',
    region: '',
    city: '',
    area: '',
    landmark: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  // Every order checkout made — one per store — with its decision.
  const [decided, setDecided] = useState<DecidedOrder[] | null>(null);
  const [shopNames, setShopNames] = useState<Record<string, string>>({});

  const subtotal = cart.data?.subtotal_pesewas ?? 0;
  const addressList = addresses.data ?? [];
  const chosenAddress =
    addressList.find((a) => a.id === addressId) ??
    addressList.find((a) => a.is_default) ??
    addressList[0] ??
    null;

  // Checkout never sends `fulfilment_method`, so the server applies its
  // default of `courier` and prices delivery against this address. The fee is
  // part of what the customer owes and part of what the plan finances, so
  // every figure below is derived from `total`, not `subtotal`. Quoting the
  // plan on the subtotal understated both the instalments and the total.
  const delivery = useDeliveryQuote(chosenAddress?.id);
  // Until the fee is known the total is a lie, so the plan offers wait for it
  // rather than render a figure that moves under the customer.
  const totalKnown = chosenAddress === null || delivery.isSuccess;
  const deliveryFee = chosenAddress === null ? 0 : delivery.data?.fee_pesewas;

  /**
   * The orders checkout will make — one per store, each with its own delivery
   * fee and, on instalments, its own plan on its own amount. This charged
   * delivery once and quoted one plan on the combined total: a two-shop basket
   * read GHS 480 against orders of GHS 160 + GHS 335, and offered a plan that
   * one of the orders might not qualify for.
   */
  const shops = shopOrders(cart.data?.items ?? [], totalKnown ? deliveryFee : undefined);
  const deliveryTotal = (deliveryFee ?? 0) * shops.length;
  const total = subtotal + deliveryTotal;
  const shopQuotes = usePlanQuotes(shops.map((shop) => shop.amountPesewas ?? 0));
  const commonIds = totalKnown ? commonEligibleTemplateIds(shopQuotes) : null;
  // Each offer is one template, as each order's own plan on it.
  const offers = (commonIds ?? [])
    .map((id) => ({
      id,
      plans: shopQuotes.map((quotes) => quotes!.find((q) => q.plan_template_id === id)!),
    }))
    .sort((a, b) => sum(a.plans, perInstalment) - sum(b.plans, perInstalment));
  const chosenPlan = offers.find((o) => o.id === planId) ?? null;

  /**
   * One key per checkout attempt, held across retries so a timed-out attempt
   * replays its order instead of opening a second. It was rotated only after a
   * successful order, so changing the plan or address after a failure sent the
   * new body under the old key — which the server answers with a 409.
   */
  const checkoutKey = useRef(newIdempotencyKey('checkout'));
  const signature = `${paymentType}:${planId ?? ''}:${chosenAddress?.id ?? ''}`;
  const lastSignature = useRef(signature);
  if (lastSignature.current !== signature) {
    lastSignature.current = signature;
    checkoutKey.current = newIdempotencyKey('checkout');
  }

  // Before the empty-cart state: checkout has emptied the cart by now.
  if (decided) return <CheckoutResult decided={decided} shopNames={shopNames} />;

  if (cart.isPending) return <LoadingState />;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;

  if ((cart.data?.items ?? []).length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Checkout</h1>
        <p className="text-sm text-muted-foreground">Your cart is empty.</p>
        <Button variant="outline" onClick={() => navigate('/')}>
          Start shopping
        </Button>
      </div>
    );
  }

  function onCreateAddress(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      recipient: form.recipient,
      phone: form.phone,
      region: form.region,
      city: form.city,
      ...(form.area ? { area: form.area } : {}),
      ...(form.landmark ? { landmark: form.landmark } : {}),
      is_default: addressList.length === 0,
    };
    const parsed = createAddressSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the address details');
      return;
    }
    createAddress.mutate(parsed.data, {
      onSuccess: (created) => {
        setAddressId(created.id);
        setShowAddressForm(false);
        setForm({ recipient: '', phone: '', region: '', city: '', area: '', landmark: '' });
      },
    });
  }

  function onPlaceOrder() {
    setFormError(null);
    const payload = {
      payment_type: paymentType,
      ...(chosenAddress ? { shipping_address_id: chosenAddress.id } : {}),
      ...(paymentType === 'installment' && planId ? { plan_template_id: planId } : {}),
    };
    const parsed = checkoutSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check your selections');
      return;
    }
    checkout.mutate(
      { ...parsed.data, idempotencyKey: checkoutKey.current },
      {
        onSuccess: (orders) => {
          checkoutKey.current = newIdempotencyKey('checkout');
          setShopNames(Object.fromEntries(shops.map((shop) => [shop.storeId, shop.name])));
          setDecided(orders);
          window.scrollTo(0, 0);
        },
      },
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Checkout</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="size-4 text-primary" />
            Delivery address
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {addresses.isPending ? (
            <LoadingState label="Loading addresses…" />
          ) : (
            <>
              {addressList.map((a) => {
                const active = chosenAddress?.id === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAddressId(a.id)}
                    className={cn(
                      'flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors',
                      active
                        ? 'border-primary bg-primary/5'
                        : 'border-input hover:border-primary/40',
                    )}
                  >
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{a.recipient}</p>
                      <p className="text-xs text-muted-foreground">
                        {[a.area, a.city, a.region].filter(Boolean).join(', ')}
                      </p>
                      <p className="text-xs text-muted-foreground">{a.phone}</p>
                    </div>
                    {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })}

              {showAddressForm ? (
                <form
                  onSubmit={onCreateAddress}
                  className="space-y-3 rounded-md border border-border p-3"
                >
                  <div className="space-y-2">
                    <Label>Recipient</Label>
                    <Input
                      value={form.recipient}
                      onChange={(e) => setForm((f) => ({ ...f, recipient: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                      placeholder="024 123 4567"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Region</Label>
                      <Input
                        value={form.region}
                        onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
                        placeholder="Greater Accra"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>City</Label>
                      <Input
                        value={form.city}
                        onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                        placeholder="Accra"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Area (optional)</Label>
                    <Input
                      value={form.area}
                      onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Landmark (optional)</Label>
                    <Input
                      value={form.landmark}
                      onChange={(e) => setForm((f) => ({ ...f, landmark: e.target.value }))}
                    />
                  </div>
                  {createAddress.isError ? (
                    <p className="text-sm text-destructive">
                      {apiErrorMessage(createAddress.error)}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={createAddress.isPending}>
                      {createAddress.isPending ? 'Saving…' : 'Save address'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAddressForm(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setShowAddressForm(true)}>
                  <Plus />
                  {addressList.length === 0 ? 'Add an address' : 'Use a new address'}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How would you like to pay?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {(['installment', 'full'] as PaymentType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setPaymentType(t)}
                className={cn(
                  'rounded-md border p-3 text-left text-sm transition-colors',
                  paymentType === t
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-input hover:border-primary/40',
                )}
              >
                <span className="font-medium">
                  {t === 'installment' ? 'In instalments' : 'Pay in full'}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t === 'installment' ? 'Spread the cost' : totalKnown ? formatGhs(total) : '—'}
                </span>
              </button>
            ))}
          </div>

          {paymentType === 'installment' ? (
            !totalKnown || commonIds === null ? (
              <LoadingState label="Working out your plans…" />
            ) : offers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{noPlanReason(shops, shopQuotes)}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Choose a plan</p>
                {shops.length > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    Your basket is {shops.length} orders, one per shop, and each is on its own plan.
                  </p>
                ) : null}
                {offers.map(({ id, plans }) => {
                  const active = planId === id;
                  const first = plans[0]!;
                  const dueToday = sum(plans, (q) => q.down_payment_pesewas);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPlanId(id)}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors',
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-input hover:border-primary/40',
                      )}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium">{first.name}</p>
                        {plans.map((plan, i) => (
                          <p key={shops[i]!.storeId} className="text-xs text-muted-foreground">
                            {shops.length > 1 ? `${shops[i]!.name}: ` : ''}
                            {planLine(plan)}
                          </p>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          Total {formatGhs(sum(plans, (q) => q.total_payable_pesewas))}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold">
                          {formatGhs(dueToday > 0 ? dueToday : sum(plans, perInstalment))}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {dueToday > 0
                            ? 'today'
                            : `/ ${cadenceLabel(first.installment_frequency_days)}`}
                        </p>
                      </div>
                    </button>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Instalment orders need approval — we check your eligibility right after you place
                  the order.
                </p>
              </div>
            )
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Subtotal</span>
            <span className="text-sm">{formatGhs(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Delivery{shops.length > 1 ? ` · ${shops.length} orders` : ''}
            </span>
            <span className="text-sm">
              {chosenAddress === null
                ? 'Add an address'
                : delivery.isSuccess
                  ? formatGhs(deliveryTotal)
                  : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-sm text-muted-foreground">Order total</span>
            <span className="text-lg font-semibold">{totalKnown ? formatGhs(total) : '—'}</span>
          </div>
        </CardContent>
      </Card>

      {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
      {checkout.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(checkout.error)}</p>
      ) : null}

      <Button
        className="w-full"
        size="lg"
        disabled={
          checkout.isPending || !chosenAddress || (paymentType === 'installment' && !chosenPlan)
        }
        onClick={onPlaceOrder}
      >
        {checkout.isPending ? 'Placing order…' : 'Place order'}
      </Button>
      {!chosenAddress ? (
        <p className="text-center text-xs text-muted-foreground">
          Add a delivery address to continue.
        </p>
      ) : null}
    </div>
  );
}

const perInstalment = (q: PlanQuote) => q.per_installment_pesewas;

function sum(plans: readonly PlanQuote[], pick: (q: PlanQuote) => number): number {
  return plans.reduce((total, q) => total + pick(q), 0);
}

/**
 * A plan in a line, from the engine's own quote. `number_of_installments`
 * excludes the deposit, so with a deposit it is the count that follows it;
 * without one every payment is in `installments`.
 */
function planLine(q: PlanQuote): string {
  const every = cadenceLabel(q.installment_frequency_days);
  return q.down_payment_pesewas > 0
    ? `${formatGhs(q.down_payment_pesewas)} today, then ${q.number_of_installments} × ${formatGhs(q.per_installment_pesewas)} every ${every}`
    : `${q.installments.length} × ${formatGhs(q.per_installment_pesewas)} every ${every}, nothing today`;
}

/**
 * What checkout did, order by order.
 *
 * Checkout scores and activates before it answers, so each order already has
 * its outcome — approved with a deposit to pay, approved with nothing due
 * today, declined, under review, or awaiting payment in full. This page went
 * straight to the first order instead (and, reading the wrong field, to an
 * order that did not exist), so a decline, a deposit, and every order after
 * the first went unmentioned.
 */
function CheckoutResult({
  decided,
  shopNames,
}: {
  decided: DecidedOrder[];
  shopNames: Record<string, string>;
}) {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">
        {decided.length > 1 ? `${decided.length} orders placed` : 'Order placed'}
      </h1>
      {decided.map((d) => (
        <Card key={d.order.id}>
          <CardContent className="space-y-2 p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{shopNames[d.order.store_id] ?? d.order.order_number}</p>
                <p className="text-xs text-muted-foreground">
                  {d.order.order_number} · {formatGhs(d.order.total_pesewas)}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 text-xs font-medium',
                  d.outcome === 'approved' || d.outcome === 'paid_later'
                    ? 'text-primary'
                    : 'text-muted-foreground',
                )}
              >
                {OUTCOME_LABEL[d.outcome]}
              </span>
            </div>
            <OutcomeDetail decided={d} />
          </CardContent>
        </Card>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" asChild>
          <Link to="/orders">See my orders</Link>
        </Button>
        <Button variant="ghost" className="flex-1" asChild>
          <Link to="/">Keep shopping</Link>
        </Button>
      </div>
    </div>
  );
}

const OUTCOME_LABEL: Record<DecidedOrder['outcome'], string> = {
  approved: 'Approved',
  paid_later: 'Awaiting payment',
  declined: 'Not approved',
  in_review: 'Being reviewed',
  failed: 'Not placed',
};

function OutcomeDetail({ decided: d }: { decided: DecidedOrder }) {
  if (d.outcome === 'paid_later') {
    return (
      <Button size="sm" asChild>
        <Link to={`/orders/${d.order.id}`}>Pay {formatGhs(d.order.total_pesewas)} now</Link>
      </Button>
    );
  }
  if (d.outcome === 'approved' && d.plan) {
    const first = d.schedule.find((row) => row.id !== d.down_payment?.id) ?? null;
    return (
      <>
        <p className="text-muted-foreground">
          {d.down_payment
            ? `Pay the ${formatGhs(d.down_payment.amount_due_pesewas)} deposit to start your plan.`
            : first
              ? `Nothing to pay today. Your first payment of ${formatGhs(first.amount_due_pesewas)} is due ${formatDate(first.due_date)}.`
              : 'Nothing to pay today.'}
        </p>
        <Button size="sm" variant={d.down_payment ? 'default' : 'outline'} asChild>
          <Link to={`/plans/${d.plan.id}`}>
            {d.down_payment
              ? `Pay ${formatGhs(d.down_payment.amount_due_pesewas)} deposit`
              : 'See my plan'}
          </Link>
        </Button>
      </>
    );
  }
  return (
    <p className="text-muted-foreground">
      {d.message ??
        (d.outcome === 'declined'
          ? 'We could not approve instalments for this order. Nothing was charged.'
          : d.outcome === 'in_review'
            ? 'We are checking a few things and will let you know.'
            : 'This order could not be placed. Nothing was charged.')}
    </p>
  );
}
