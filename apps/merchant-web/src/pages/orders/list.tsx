import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMerchantOrders } from '../../lib/merchant-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

/**
 * Ordered the way a seller thinks about their day: the two states that mean
 * "money is in, go and pack it" first, then the rest of the ladder, then the
 * ones that ended badly.
 */
const STATUS = [
  { value: '', label: 'All orders' },
  { value: 'paid', label: 'Paid — to pack' },
  { value: 'financing_active', label: 'Financed — to pack' },
  { value: 'fulfilling', label: 'Packing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'pending_approval', label: 'Awaiting approval' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'returned', label: 'Returned' },
];
const PAGE_SIZE = 25;

export function OrdersListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isPending, isError, error, refetch, isFetching } = useMerchantOrders({
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const hasNext = offset + rows.length < total;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="What people have bought from you, and where each one has got to."
        actions={
          <select
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        }
      />

      <Card>
        {isPending ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="No orders match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="hidden sm:table-cell">Items</TableHead>
                <TableHead>Total</TableHead>
                <TableHead className="hidden lg:table-cell">Payment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Placed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow
                  key={o.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/orders/${o.id}`)}
                >
                  <TableCell className="font-medium">{o.order_number}</TableCell>
                  <TableCell className="hidden max-w-[18rem] truncate text-muted-foreground sm:table-cell">
                    {summariseItems(o.items)}
                  </TableCell>
                  <TableCell>{formatGhs(o.total_pesewas)}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {o.payment_type === 'installment' ? 'Instalments' : 'Pay now'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDate(o.placed_at ?? o.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {total === 0 ? '' : `${offset + 1}–${offset + rows.length} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || isFetching}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || isFetching}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Kente scarf ×2" or "Kente scarf ×2 + 2 more" — enough to recognise the order. */
function summariseItems(items: { title: string; quantity: number }[]): string {
  const first = items[0];
  if (!first) return '—';
  const head = first.quantity > 1 ? `${first.title} ×${first.quantity}` : first.title;
  return items.length > 1 ? `${head} + ${items.length - 1} more` : head;
}
