import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  formatStatusLabel,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatBps, formatGhs } from '@installment/api-types';
import { ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { useMerchants, useSellersOwing } from '../../lib/merchants-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending_kyc', label: 'Pending KYC' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'offboarded', label: 'Offboarded' },
];

const PAGE_SIZE = 25;

export function MerchantsListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isPending, isError, error, refetch, isFetching } = useMerchants({
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const rows = data ?? [];
  const hasNext = rows.length === PAGE_SIZE;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Merchants"
        description="Retail partners who originate orders and receive settlements."
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => navigate('/merchants/new')}>
              <Plus />
              New merchant
            </Button>
          </div>
        }
      />

      <SellersOwingCard />

      <Card>
        {isPending ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="No merchants match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>MDR</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Onboarded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow
                  key={m.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/merchants/${m.id}`)}
                >
                  <TableCell className="font-medium">{m.business_name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell>{formatStatusLabel(m.default_business_model)}</TableCell>
                  <TableCell className="tabular-nums">
                    {/* The negotiated rate, or the plan's own: `default_mdr_bps`
                        is display-only and charged by nothing. */}
                    {m.mdr_bps_override === null ? 'Plan rate' : formatBps(m.mdr_bps_override)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={m.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(m.onboarded_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2 text-sm">
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

/**
 * Sellers owing Ejua: a negative payable, usually after returns. There is no
 * escrow — sellers are paid daily — so this is how the one risk escrow would
 * have covered gets seen: a seller paid out who then owes it back. A seller
 * who is suspended or offboarded will never be paid again, so what they owe
 * is recovered by hand or lost; they are listed first.
 *
 * Hidden when nobody owes anything.
 */
function SellersOwingCard() {
  const navigate = useNavigate();
  const owing = useSellersOwing();
  if (owing.isPending || owing.isError || owing.data.summary.sellers === 0) return null;
  const { summary, rows } = owing.data;

  return (
    <Card className={summary.unrecoverable_sellers > 0 ? 'border-destructive/40' : ''}>
      <div className="space-y-1 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <TriangleAlert className="size-4 text-warning" />
          {summary.sellers} {summary.sellers === 1 ? 'seller owes' : 'sellers owe'} Ejua{' '}
          {formatGhs(summary.owed_pesewas)}
        </p>
        <p className="text-sm text-muted-foreground">
          Usually returns taken back after a payout. It comes off their next payouts
          {summary.unrecoverable_sellers > 0
            ? ` — except ${formatGhs(summary.unrecoverable_pesewas)} owed by ${summary.unrecoverable_sellers} who can no longer be paid out, which has to be recovered directly.`
            : '.'}
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Owes</TableHead>
            <TableHead>Returns, 90 days</TableHead>
            <TableHead>Last payout</TableHead>
            <TableHead>Selling for</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.merchant_id}
              className="cursor-pointer"
              onClick={() => navigate(`/merchants/${r.merchant_id}`)}
            >
              <TableCell className="font-medium">{r.business_name}</TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell
                className={`tabular-nums ${r.unrecoverable ? 'font-semibold text-destructive' : ''}`}
              >
                {formatGhs(r.owed_pesewas)}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {r.returns_90d_count > 0
                  ? `${formatGhs(r.returns_90d_pesewas)} (${r.returns_90d_count})`
                  : '—'}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {r.last_payout_at
                  ? `${formatGhs(r.last_payout_pesewas ?? 0)}, ${formatDate(r.last_payout_at)}`
                  : '—'}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {r.seller_age_days} {r.seller_age_days === 1 ? 'day' : 'days'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
