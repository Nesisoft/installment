import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, StatusBadge } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { ArrowLeft } from 'lucide-react';
import { useOrder, useOrders } from '../lib/shop-api';
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
                        {o.payment_type === 'installment' ? 'In instalments' : 'Paid in full'}
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

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const order = useOrder(id);

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

      {o.payment_type === 'installment' ? (
        <Card className="border-primary/40">
          <CardContent className="p-4 text-sm">
            {o.customer_plan_id ? (
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
