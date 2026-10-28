import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  Input,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs, type OrderStatus } from '@installment/api-types';
import { useAdminOrderCounts, useAdminOrders } from '../../lib/orders-api';
import { ORDER_STATUS_FILTERS } from '../../lib/orders';
import { formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE = 50;

export function OrdersListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [paymentType, setPaymentType] = useState<'' | 'full' | 'installment'>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);

  const counts = useAdminOrderCounts();
  const list = useAdminOrders({
    ...(status ? { status } : {}),
    ...(paymentType ? { payment_type: paymentType } : {}),
    ...(q ? { q } : {}),
    limit: PAGE,
    offset: page * PAGE,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setQ(search.trim());
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="Every seller's orders. Open one to confirm a payment, cancel it, or see its returns."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Status"
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as OrderStatus | '');
                setPage(0);
              }}
            >
              {ORDER_STATUS_FILTERS.map((s) => {
                const n = counts.data ? counts.data[s.value || 'all'] : undefined;
                return (
                  <option key={s.value} value={s.value}>
                    {s.label}
                    {n !== undefined ? ` (${n})` : ''}
                  </option>
                );
              })}
            </select>
            <select
              aria-label="Payment type"
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={paymentType}
              onChange={(e) => {
                setPaymentType(e.target.value as '' | 'full' | 'installment');
                setPage(0);
              }}
            >
              <option value="">Pay in full and instalments</option>
              <option value="full">Pay in full</option>
              <option value="installment">Instalments</option>
            </select>
            <form onSubmit={onSearch} className="flex gap-2">
              <Input
                aria-label="Order number or id"
                placeholder="Order number or id"
                className="h-9 w-48"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button type="submit" variant="outline" size="sm">
                Find
              </Button>
            </form>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState message="No orders match." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Seller</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/orders/${o.id}`)}
                  >
                    <TableCell>
                      <div className="font-mono text-xs font-medium">{o.order_number}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(o.created_at)}
                      </div>
                    </TableCell>
                    <TableCell>{o.customer_name ?? '—'}</TableCell>
                    <TableCell>
                      <div>{o.merchant_name ?? '—'}</div>
                      {o.store_name ? (
                        <div className="text-xs text-muted-foreground">{o.store_name}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{o.item_count}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatGhs(o.total_pesewas)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {o.payment_type === 'installment' ? 'Instalments' : 'Pay in full'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {total > PAGE ? (
            <div className="flex items-center justify-between border-t border-border px-6 py-3 text-sm">
              <span className="text-muted-foreground">
                {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
