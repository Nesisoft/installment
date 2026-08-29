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
import { useMerchantPlans } from '../../lib/merchant-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const STATUS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'defaulted', label: 'Defaulted' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'restructured', label: 'Restructured' },
];
const PAGE_SIZE = 25;

export function PlansListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isPending, isError, error, refetch, isFetching } = useMerchantPlans({
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const rows = data ?? [];
  const hasNext = rows.length === PAGE_SIZE;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans"
        description="Installment agreements created from your orders."
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
          <EmptyState message="No plans match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead className="hidden sm:table-cell">Order amount</TableHead>
                <TableHead>Outstanding</TableHead>
                <TableHead className="hidden lg:table-cell">Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/plans/${p.id}`)}
                >
                  <TableCell className="font-mono text-xs">{p.id.slice(0, 8)}…</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {formatGhs(p.order_amount_pesewas)}
                  </TableCell>
                  <TableCell>{formatGhs(p.outstanding_pesewas)}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {p.business_model}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDate(p.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2">
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
  );
}
