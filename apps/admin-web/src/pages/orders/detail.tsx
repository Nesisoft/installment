import { useState, type FormEvent, type ReactNode } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs, type AdminOrderDetail } from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import { useAdminOrder, useCancelOrder, useConfirmOrderPayment } from '../../lib/orders-api';
import { orderActions } from '../../lib/orders';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

function bps(value: number | null): string {
  return value === null ? '' : ` (${(value / 100).toFixed(2)}%)`;
}

function deliveryLine(o: AdminOrderDetail): string {
  const d = o.delivery;
  if (d.method === 'pickup') return [d.hub_name, d.hub_detail].filter(Boolean).join(' — ') || '—';
  return (
    [d.recipient, d.phone, d.area, d.city, d.region, d.landmark, d.ghanapost_gps]
      .filter(Boolean)
      .join(', ') || 'No address on file'
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const order = useAdminOrder(id);
  const confirm = useConfirmOrderPayment(id);
  const cancel = useCancelOrder(id);

  const [paymentRef, setPaymentRef] = useState('');
  // Minted when the form is first submitted, reused if that submit is retried.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  if (order.isPending) return <LoadingState />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;
  const actions = orderActions(o);

  function onConfirm(e: FormEvent) {
    e.preventDefault();
    const reference = paymentRef.trim();
    if (!reference) return;
    const key = confirmKey ?? newIdempotencyKey(`order-pay-${id}`);
    setConfirmKey(key);
    confirm.mutate(
      { providerReference: reference, idempotencyKey: key },
      { onSuccess: () => setConfirmKey(null) },
    );
  }

  function onCancel(e: FormEvent) {
    e.preventDefault();
    cancel.mutate(cancelReason.trim() || undefined, {
      onSuccess: () => setCancelling(false),
    });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Orders
      </Link>

      <PageHeader
        title={`Order ${o.order_number}`}
        description={`${formatGhs(o.total_pesewas)} · ${o.payment_type === 'installment' ? 'Instalments' : 'Pay in full'} · ordered ${formatDateTime(o.created_at)}${o.placed_at ? ` · paid or financed ${formatDateTime(o.placed_at)}` : ''}`}
        actions={<StatusBadge status={o.status} />}
      />

      {actions.confirmPayment ? (
        <Card className="border-warning/60">
          <CardHeader>
            <CardTitle className="text-base">Confirm payment</CardTitle>
            <CardDescription>
              For money that arrived outside the checkout — a bank transfer, cash on delivery, a
              Mobile Money payment reconciled by hand. This books the payment, the seller&apos;s
              share and the commission, and commits the stock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onConfirm} className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1 space-y-2">
                <Label htmlFor="payment-ref">Payment reference</Label>
                <Input
                  id="payment-ref"
                  required
                  maxLength={200}
                  placeholder="Transfer reference, receipt or till number"
                  value={paymentRef}
                  onChange={(e) => {
                    setPaymentRef(e.target.value);
                    // A different reference is a different request.
                    setConfirmKey(null);
                  }}
                />
              </div>
              <Button type="submit" disabled={confirm.isPending || !paymentRef.trim()}>
                {confirm.isPending ? 'Booking…' : `Confirm ${formatGhs(o.total_pesewas)} paid`}
              </Button>
            </form>
            {confirm.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(confirm.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Customer"
              value={
                o.customer ? (
                  <Link to={`/customers/${o.customer.id}`} className="text-primary hover:underline">
                    {o.customer.name ?? o.customer.phone}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Field label="Phone" value={o.customer?.phone ?? '—'} />
            <Field label="Email" value={o.customer?.email ?? '—'} />
            <Field
              label="Seller"
              value={
                o.merchant ? (
                  <Link to={`/merchants/${o.merchant.id}`} className="text-primary hover:underline">
                    {o.merchant.business_name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Field label="Store" value={o.store?.display_name ?? '—'} />
            <Field
              label={o.delivery.method === 'pickup' ? 'Pickup at' : 'Deliver to'}
              value={deliveryLine(o)}
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Money</CardTitle>
          <CardDescription>What the order cost, and what the ledger booked for it.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Goods" value={formatGhs(o.subtotal_pesewas)} />
            <Field label="Delivery" value={formatGhs(o.shipping_pesewas)} />
            <Field label="Discount" value={formatGhs(o.discount_pesewas)} />
            <Field label="Total" value={formatGhs(o.total_pesewas)} />
            <Field label="Payment reference" value={o.payment_reference ?? '—'} />
            <Field
              label="Booked"
              value={o.settlement.bookedAt ? formatDateTime(o.settlement.bookedAt) : 'Nothing yet'}
            />
            {/* The seller's side exists only once the ledger has booked it. */}
            {o.settlement.bookedAt ? (
              <>
                <Field label="Gross to seller" value={formatGhs(o.settlement.grossPesewas)} />
                <Field
                  label={o.settlement.feeLabel === 'mdr' ? 'MDR' : 'Commission'}
                  value={`${formatGhs(o.settlement.feePesewas)}${bps(o.settlement.feeBps)}`}
                />
                <Field
                  label="Reserve"
                  value={`${formatGhs(o.settlement.reservePesewas)}${bps(o.settlement.reserveBps)}`}
                />
                <Field label="Net to seller" value={formatGhs(o.settlement.netPesewas)} />
                <Field
                  label="Reserve still held"
                  value={formatGhs(o.settlement.reserveOutstandingPesewas)}
                />
                <Field
                  label="Reserve releases"
                  value={formatDate(o.settlement.reserveReleasesAt)}
                />
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {o.plan ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Plan</CardTitle>
            <Link to={`/plans/${o.plan.id}`} className="text-sm text-primary hover:underline">
              Open plan
            </Link>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Status" value={<StatusBadge status={o.plan.status} />} />
              <Field label="Model" value={o.plan.business_model} />
              <Field label="Paid" value={`${o.plan.paidCount} of ${o.plan.installments.length}`} />
              <Field label="Outstanding" value={formatGhs(o.plan.outstanding_pesewas)} />
              <Field label="Next due" value={formatDate(o.plan.nextDueDate)} />
              <Field label="Late" value={o.plan.late ? 'Yes' : 'No'} />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Line</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.title}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{i.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(i.unit_price_pesewas)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(i.line_total_pesewas)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {o.returns.length > 0 ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Returns</CardTitle>
            <Link to="/refunds" className="text-sm text-primary hover:underline">
              Refunds
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                  <TableHead>Refund status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.returns.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(r.requested_at)}
                    </TableCell>
                    <TableCell className="max-w-xs">{r.reason}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                      {r.decision_note ? (
                        <p className="mt-1 text-xs text-muted-foreground">{r.decision_note}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGhs(r.refund_amount_pesewas)}
                    </TableCell>
                    <TableCell>
                      {r.refund ? <StatusBadge status={r.refund.status} /> : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {o.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ol className="space-y-3">
              {o.events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="w-40 shrink-0 text-muted-foreground">
                    {formatDateTime(e.occurred_at)}
                  </span>
                  <span>
                    <span className="font-medium">{e.label}</span>
                    {e.detail ? <span className="text-muted-foreground"> — {e.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {actions.cancel ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Cancel order</CardTitle>
            <CardDescription>
              Nothing has been paid on this order. Cancelling returns its reserved stock to sale and
              closes any credit application behind it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {cancelling ? (
              <form onSubmit={onCancel} className="flex flex-wrap items-end gap-3">
                <div className="min-w-64 flex-1 space-y-2">
                  <Label htmlFor="cancel-reason">Reason (optional)</Label>
                  <Input
                    id="cancel-reason"
                    maxLength={300}
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="destructive" disabled={cancel.isPending}>
                  {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
                  Keep it
                </Button>
              </form>
            ) : (
              <Button variant="outline" onClick={() => setCancelling(true)}>
                Cancel this order…
              </Button>
            )}
            {cancel.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(cancel.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
