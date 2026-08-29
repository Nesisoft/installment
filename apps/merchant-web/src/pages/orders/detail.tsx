import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
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
import {
  formatGhs,
  markDeliveredSchema,
  markOutForDeliverySchema,
  markShippedSchema,
  type OrderWithItems,
} from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft, PackageCheck, Truck } from 'lucide-react';
import {
  useFulfilOrder,
  useMerchantOrder,
  type FulfilOrderArgs,
  type FulfilmentStep,
} from '../../lib/merchant-api';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const order = useMerchantOrder(id);

  if (order.isPending) return <LoadingState />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;

  return (
    <div className="space-y-6">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to orders
      </Link>

      <PageHeader
        title={o.order_number}
        description={`${formatGhs(o.total_pesewas)} · ${
          o.payment_type === 'installment' ? 'Instalments' : 'Pay now'
        } · ${o.fulfilment_method === 'pickup' ? 'Collection' : 'Courier delivery'}`}
        actions={<StatusBadge status={o.status} />}
      />

      <FulfilmentCard order={o} />

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
                <TableHead>Qty</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.title}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {item.sku}
                  </TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>{formatGhs(item.unit_price_pesewas)}</TableCell>
                  <TableCell>{formatGhs(item.line_total_pesewas)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Totals</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Subtotal" value={formatGhs(o.subtotal_pesewas)} />
            <Field label="Delivery" value={formatGhs(o.shipping_pesewas)} />
            <Field label="Discount" value={formatGhs(o.discount_pesewas)} />
            <Field label="Total" value={formatGhs(o.total_pesewas)} />
            <Field label="Placed" value={formatDate(o.placed_at ?? o.created_at)} />
            <Field label="Delivered" value={formatDateTime(o.delivered_at)} />
            <Field label="Return window ends" value={formatDate(o.return_window_ends_at)} />
            <Field
              label="Commission"
              value={o.commission_bps ? `${(o.commission_bps / 100).toFixed(2)}%` : '—'}
            />
          </dl>
          {o.customer_plan_id ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Financed —{' '}
              <Link
                to={`/plans/${o.customer_plan_id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                view the instalment plan
              </Link>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Fulfilment -------------------------------------------------------------

interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'tel' | 'datetime-local';
}

/**
 * Every field is optional, matching the API: a seller who hands a parcel to a
 * passing rider knows nothing but "it has gone", and refusing the update
 * without a tracking code would either stall the order or get a made-up one.
 */
const FORM_FIELDS: Record<Exclude<FulfilmentStep, 'fulfilling'>, FormField[]> = {
  ship: [
    { name: 'courier_name', label: 'Courier' },
    { name: 'rider_name', label: 'Rider' },
    { name: 'courier_phone', label: 'Courier phone', type: 'tel' },
    { name: 'tracking_code', label: 'Tracking code' },
    { name: 'eta_at', label: 'Expected arrival', type: 'datetime-local' },
    { name: 'note', label: 'Note to the buyer' },
  ],
  'out-for-delivery': [
    { name: 'rider_name', label: 'Rider' },
    { name: 'courier_phone', label: 'Rider phone', type: 'tel' },
    { name: 'eta_at', label: 'Expected arrival', type: 'datetime-local' },
    { name: 'note', label: 'Note to the buyer' },
  ],
  delivered: [
    { name: 'delivered_at', label: 'When (leave blank for now)', type: 'datetime-local' },
    { name: 'received_by', label: 'Received by' },
    { name: 'note', label: 'Note to the buyer' },
  ],
};

/** What the seller can do next, given where the order is. Mirrors the API guards. */
function availableSteps(status: string): FulfilmentStep[] {
  if (status === 'paid' || status === 'financing_active') return ['fulfilling', 'ship'];
  if (status === 'fulfilling') return ['ship'];
  if (status === 'shipped') return ['out-for-delivery', 'delivered'];
  return [];
}

function stepLabel(step: FulfilmentStep, pickup: boolean): string {
  if (step === 'fulfilling') return 'Start packing';
  if (step === 'ship') return pickup ? 'Sent to the pickup point' : 'Mark shipped';
  if (step === 'out-for-delivery') return 'Out for delivery';
  return pickup ? 'Mark collected' : 'Mark delivered';
}

function FulfilmentCard({ order }: { order: OrderWithItems }) {
  const fulfil = useFulfilOrder(order.id);
  const [open, setOpen] = useState<Exclude<FulfilmentStep, 'fulfilling'> | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const pickup = order.fulfilment_method === 'pickup';
  const steps = availableSteps(order.status);

  function start(step: FulfilmentStep) {
    if (step === 'fulfilling') {
      fulfil.mutate({ step });
      return;
    }
    setValues({});
    setFormError(null);
    setOpen((current) => (current === step ? null : step));
  }

  function submit() {
    if (!open) return;
    const args = validate(open, buildBody(values));
    if (!args) {
      setFormError('Check the details — something there is too long or not a valid time.');
      return;
    }
    setFormError(null);
    fulfil.mutate(args, {
      onSuccess: () => {
        setOpen(null);
        setValues({});
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="size-4 text-primary" />
          Fulfilment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {steps.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <PackageCheck className="size-4" />
            {closedMessage(order)}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {steps.map((step) => (
              <Button
                key={step}
                variant={step === open ? 'default' : 'outline'}
                size="sm"
                disabled={fulfil.isPending}
                onClick={() => start(step)}
              >
                {stepLabel(step, pickup)}
              </Button>
            ))}
          </div>
        )}

        {open ? (
          <div className="space-y-4 rounded-md border border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {FORM_FIELDS[open].map((field) => (
                <div key={field.name} className="space-y-1.5">
                  <Label htmlFor={field.name}>{field.label}</Label>
                  <Input
                    id={field.name}
                    type={field.type ?? 'text'}
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={fulfil.isPending} onClick={submit}>
                {stepLabel(open, pickup)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={fulfil.isPending}
                onClick={() => setOpen(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
        {fulfil.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(fulfil.error)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Why there is nothing to do — a bare disabled panel reads as a bug, and the
 * reason is different for an order still awaiting money than for one that is
 * already in the buyer's hands.
 */
function closedMessage(order: OrderWithItems): string {
  switch (order.status) {
    case 'pending_payment':
      return 'Waiting for the buyer to pay. Nothing to send yet.';
    case 'pending_approval':
      return 'Waiting on the financing decision. Nothing to send yet.';
    case 'delivered':
      return order.fulfilment_method === 'pickup'
        ? `Collected ${formatDate(order.delivered_at)}. The return window closes ${formatDate(order.return_window_ends_at)}.`
        : `Delivered ${formatDate(order.delivered_at)}. The return window closes ${formatDate(order.return_window_ends_at)}.`;
    case 'completed':
      return 'Complete — the return window has closed and this order can be settled.';
    default:
      return 'This order is closed. Nothing left to fulfil.';
  }
}

/**
 * Runs the same schema the route runs, so a value the API would reject never
 * costs a round trip — and, because each branch narrows to its own step, the
 * body reaching the mutation is typed rather than cast.
 */
function validate(
  step: Exclude<FulfilmentStep, 'fulfilling'>,
  body: Record<string, string>,
): FulfilOrderArgs | null {
  switch (step) {
    case 'ship': {
      const parsed = markShippedSchema.safeParse(body);
      return parsed.success ? { step, body: parsed.data } : null;
    }
    case 'out-for-delivery': {
      const parsed = markOutForDeliverySchema.safeParse(body);
      return parsed.success ? { step, body: parsed.data } : null;
    }
    case 'delivered': {
      const parsed = markDeliveredSchema.safeParse(body);
      return parsed.success ? { step, body: parsed.data } : null;
    }
  }
}

/**
 * Drops blanks and turns the browser's local datetime into the offset ISO the
 * API validates. Sending `courier_name: ''` would store an empty courier and
 * show the buyer a blank line where a name belongs.
 */
function buildBody(values: Record<string, string>): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (!value) continue;
    if (key === 'eta_at' || key === 'delivered_at') {
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) continue;
      body[key] = at.toISOString();
    } else {
      body[key] = value;
    }
  }
  return body;
}
