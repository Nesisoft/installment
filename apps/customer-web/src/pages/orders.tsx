import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { apiErrorMessage, apiErrorStatus, newIdempotencyKey } from '@installment/web-kit';
import { ArrowLeft, Smartphone } from 'lucide-react';
import { useOrder, useOrders, usePayOrderMomo } from '../lib/shop-api';
import { formatDate } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

export function OrdersPage() {
  const orders = useOrders();

  if (orders.isPending) return <LoadingState />;
  if (orders.isError)
    return <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />;

  const rows = orders.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Your orders</h1>
      {rows.length === 0 ? (
        <EmptyState message="No orders yet." />
      ) : (
        <ul className="space-y-3">
          {rows.map((o) => (
            <li key={o.id}>
              <Link to={`/orders/${o.id}`}>
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{o.order_number}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(o.placed_at ?? o.created_at)} · {o.items.length} item
                          {o.items.length === 1 ? '' : 's'}
                        </p>
                      </div>
                      <StatusBadge status={o.status} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {/* The payment type, not its state: "Paid in full" sat beside a
                            Pending Payment badge on every unpaid order. */}
                        {o.payment_type === 'installment' ? 'In instalments' : 'Pay in full'}
                      </span>
                      <span className="text-sm font-semibold">{formatGhs(o.total_pesewas)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MOMO_PROVIDERS = [
  { value: 'mtn', label: 'MTN' },
  { value: 'vod', label: 'Telecel' },
  { value: 'tgo', label: 'AirtelTigo' },
] as const;

export function OrderDetailPage() {
  const { id = '' } = useParams();
  // While a charge is awaiting approval on the customer's handset, the webhook
  // is what settles it — so poll until the order stops being unpaid.
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const order = useOrder(id, { pollMs: awaitingApproval ? 3000 : undefined });
  const payMomo = usePayOrderMomo(id);
  const [momo, setMomo] = useState({ phone: '', provider: 'mtn' as 'mtn' | 'tgo' | 'vod' });
  /**
   * One key per attempt. A retry after a timeout reuses it, so a charge that
   * succeeded while the response was lost is replayed, not repeated. Any
   * answer the server gave retires it: that answer is now stored under the
   * key, so reusing it replays it. This kept the key after a decline, so
   * "Pay" again returned the same decline, and a corrected number under the
   * same key was refused as a conflict — the order could not be paid here.
   */
  const [payKey, setPayKey] = useState(() => newIdempotencyKey('order-pay'));
  const [failure, setFailure] = useState<string | null>(null);

  function onPay(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    if (!momo.phone.trim()) {
      setFailure('Enter the Mobile Money number to charge.');
      return;
    }
    payMomo.mutate(
      { phone: momo.phone.trim(), provider: momo.provider, idempotencyKey: payKey },
      {
        onSuccess: (result) => {
          setPayKey(newIdempotencyKey('order-pay'));
          if (result.status === 'paid') {
            setAwaitingApproval(false);
            return;
          }
          if (result.status === 'failed') {
            setAwaitingApproval(false);
            setFailure(
              'That payment did not go through. Check the number and network, and that there is enough in the wallet, then try again.',
            );
            return;
          }
          // Not paid yet — they still have to approve it on the handset.
          setAwaitingApproval(true);
        },
        onError: (err) => {
          // A charge under the last prompt may still land; the server will not
          // start another over it.
          if (apiErrorStatus(err) === 409) {
            setAwaitingApproval(true);
            setFailure('Your last prompt is still waiting. Approve it on your phone first.');
          }
        },
      },
    );
  }

  if (order.isPending) return <LoadingState />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;

  const o = order.data;
  if (!o) return null;

  return (
    <div className="space-y-5">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to orders
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{o.order_number}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(o.placed_at ?? o.created_at)}
          </p>
        </div>
        <StatusBadge status={o.status} />
      </div>

      {o.payment_type === 'full' && o.status === 'pending_payment' ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="size-4 text-primary" />
              Pay {formatGhs(o.total_pesewas)} with Mobile Money
            </CardTitle>
            <CardDescription>
              We will send a prompt to this number. Approve it on your phone to complete the order.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onPay} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="momo-phone">Mobile Money number</Label>
                <Input
                  id="momo-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="024 123 4567"
                  value={momo.phone}
                  onChange={(e) => setMomo((m) => ({ ...m, phone: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="momo-provider">Network</Label>
                <select
                  id="momo-provider"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={momo.provider}
                  onChange={(e) =>
                    setMomo((m) => ({ ...m, provider: e.target.value as 'mtn' | 'tgo' | 'vod' }))
                  }
                >
                  {MOMO_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {awaitingApproval ? (
                <p className="text-sm text-muted-foreground">
                  Check your phone and approve the prompt. This page updates on its own once the
                  payment goes through.
                </p>
              ) : null}
              {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
              {payMomo.isError && apiErrorStatus(payMomo.error) !== 409 ? (
                <p className="text-sm text-destructive">{apiErrorMessage(payMomo.error)}</p>
              ) : null}

              <Button type="submit" className="w-full" size="lg" disabled={payMomo.isPending}>
                {payMomo.isPending
                  ? 'Starting…'
                  : awaitingApproval
                    ? 'Send a new prompt'
                    : `Pay ${formatGhs(o.total_pesewas)} now`}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {/* Read from the order's status as well as its plan: a declined order has
          no plan either, and was told "Financing under review — we are
          checking your eligibility" beside a Declined badge. */}
      {o.payment_type === 'installment' && o.status !== 'cancelled' ? (
        <Card className="border-primary/40">
          <CardContent className="p-4 text-sm">
            {o.status === 'declined' ? (
              <>
                <p className="font-medium">Not approved</p>
                <p className="mt-1 text-muted-foreground">
                  We could not approve instalments for this order. Nothing was charged, and the
                  items are back on sale.
                </p>
              </>
            ) : o.customer_plan_id ? (
              <>
                <p className="font-medium">Financing approved</p>
                <p className="mt-1 text-muted-foreground">
                  Your repayment schedule is ready.{' '}
                  <Link
                    to={`/plans/${o.customer_plan_id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    View plan
                  </Link>
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">Financing under review</p>
                <p className="mt-1 text-muted-foreground">
                  We are checking your eligibility. You will see your repayment plan here once it is
                  approved.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {o.items.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {item.quantity} × {formatGhs(item.unit_price_pesewas)}
                </p>
              </div>
              <p className="shrink-0 text-sm font-medium">{formatGhs(item.line_total_pesewas)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatGhs(o.subtotal_pesewas)}</span>
          </div>
          {o.shipping_pesewas > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivery</span>
              <span>{formatGhs(o.shipping_pesewas)}</span>
            </div>
          ) : null}
          {o.discount_pesewas > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Discount</span>
              <span>−{formatGhs(o.discount_pesewas)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border pt-2 font-semibold">
            <span>Total</span>
            <span>{formatGhs(o.total_pesewas)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
