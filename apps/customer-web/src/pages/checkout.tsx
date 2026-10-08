import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { checkoutSchema, createAddressSchema, formatGhs } from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey } from '@installment/web-kit';
import { Check, MapPin, Plus } from 'lucide-react';
import {
  useAddresses,
  useCart,
  useCheckout,
  useCreateAddress,
  useDeliveryQuote,
  usePlanTemplates,
} from '../lib/shop-api';
import { cadenceLabel, isEligible, previewPlan } from '../lib/installment-preview';
import { ErrorState, LoadingState } from '../components/data-states';

type PaymentType = 'full' | 'installment';

export function CheckoutPage() {
  const navigate = useNavigate();
  const cart = useCart();
  const addresses = useAddresses();
  const templates = usePlanTemplates();
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
  // One key per checkout attempt. It is rotated only after a SUCCESSFUL order,
  // so retrying a failed or timed-out attempt reuses it: if the first request
  // did reach the server, the retry replays that order instead of opening a
  // second one.
  const [checkoutKey, setCheckoutKey] = useState(() => newIdempotencyKey('checkout'));

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
  const deliveryFee = delivery.data?.fee_pesewas ?? 0;
  const total = subtotal + deliveryFee;
  // Until the fee is known the total is a lie, so the plan offers wait for it
  // rather than render a figure that moves under the customer.
  const totalKnown = chosenAddress === null || delivery.isSuccess;

  const offers = useMemo(() => {
    if (!templates.data || total <= 0 || !totalKnown) return [];
    return templates.data
      .filter((t) => isEligible(t, total))
      .map((t) => ({ template: t, preview: previewPlan(t, total) }))
      .sort((a, b) => a.preview.perInstallmentPesewas - b.preview.perInstallmentPesewas);
  }, [templates.data, total, totalKnown]);

  const chosenPlan = offers.find((o) => o.template.id === planId) ?? null;

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
      { ...parsed.data, idempotencyKey: checkoutKey },
      {
        onSuccess: (orders) => {
          setCheckoutKey(newIdempotencyKey('checkout'));
          const first = orders[0];
          navigate(first ? `/orders/${first.id}` : '/orders');
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
            templates.isPending ? (
              <LoadingState label="Loading plans…" />
            ) : offers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {totalKnown
                  ? `No instalment plan covers ${formatGhs(total)} right now. You can still pay in full.`
                  : 'Working out your delivery fee…'}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Choose a plan</p>
                {offers.map(({ template, preview }) => {
                  const active = planId === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setPlanId(template.id)}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors',
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-input hover:border-primary/40',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{template.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {preview.installments} payments every{' '}
                          {cadenceLabel(preview.frequencyDays)}
                          {preview.downPaymentPesewas > 0
                            ? ` · ${formatGhs(preview.downPaymentPesewas)} upfront`
                            : ''}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Total {formatGhs(preview.totalPayablePesewas)} (estimate)
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold">
                          {formatGhs(preview.perInstallmentPesewas)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          / {cadenceLabel(preview.frequencyDays)}
                        </p>
                      </div>
                    </button>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Instalment orders need approval — we check your eligibility right after you place
                  the order. Figures shown are estimates until then.
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
            <span className="text-sm text-muted-foreground">Delivery</span>
            <span className="text-sm">
              {chosenAddress === null
                ? 'Add an address'
                : delivery.isSuccess
                  ? formatGhs(deliveryFee)
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
