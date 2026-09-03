import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import {
  useMerchantBalances,
  useMerchantPayouts,
  useMerchantReserves,
  usePayoutAccount,
} from '../lib/merchant-api';
import { formatDate, formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold">{value}</dd>
    </div>
  );
}

/**
 * The one place a merchant looks when wondering where their money is, so it is
 * where the answer belongs when the answer is "nowhere to send it". Without
 * this the daily run skips them silently and the balance above just keeps
 * climbing, which reads as the marketplace not paying.
 */
function NoPayoutAccountNotice() {
  const account = usePayoutAccount();
  if (!account.data || account.data.connected) return null;

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-warning" />
          No payout account yet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Settlements cannot be sent until you tell us where to send them. What you have earned is
          held, not lost.
        </p>
        <Button asChild variant="outline">
          <Link to="/payout-account">Add a payout account</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function SettlementsPage() {
  const [reservesOpen, setReservesOpen] = useState(true);
  const balances = useMerchantBalances();
  const payouts = useMerchantPayouts({ limit: 50 });
  const reserves = useMerchantReserves(reservesOpen);

  return (
    <div className="space-y-6">
      <PageHeader title="Settlements" description="Your payouts and held reserves." />

      <NoPayoutAccountNotice />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Balances</CardTitle>
        </CardHeader>
        <CardContent>
          {balances.isPending ? (
            <LoadingState label="Loading…" />
          ) : balances.isError ? (
            <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Pending payout" value={formatGhs(balances.data.payablePesewas)} />
              <Field label="Reserve held" value={formatGhs(balances.data.reserveHeldPesewas)} />
              <Field
                label="Lifetime settled"
                value={formatGhs(balances.data.lifetimeSettledPesewas)}
              />
              <Field label="Active plans" value={String(balances.data.activePlans)} />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payouts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {payouts.isPending ? (
            <LoadingState />
          ) : payouts.isError ? (
            <ErrorState error={payouts.error} onRetry={() => void payouts.refetch()} />
          ) : payouts.data.rows.length === 0 ? (
            <EmptyState message="No payouts yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>As of</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Settled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                    <TableCell>{formatDate(r.asOfDate)}</TableCell>
                    <TableCell>{formatGhs(r.amountPesewas)}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(r.settledAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Reserves</CardTitle>
          <select
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            value={reservesOpen ? 'open' : 'closed'}
            onChange={(e) => setReservesOpen(e.target.value === 'open')}
          >
            <option value="open">Open</option>
            <option value="closed">Released</option>
          </select>
        </CardHeader>
        <CardContent className="p-0">
          {reserves.isPending ? (
            <LoadingState />
          ) : reserves.isError ? (
            <ErrorState error={reserves.error} onRetry={() => void reserves.refetch()} />
          ) : reserves.data.length === 0 ? (
            <EmptyState message="No reserves to show." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Held</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Releasable from</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reserves.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.businessModel}</TableCell>
                    <TableCell>{formatGhs(r.amountPesewas)}</TableCell>
                    <TableCell>{formatGhs(r.outstandingPesewas)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r.releasableFrom)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
