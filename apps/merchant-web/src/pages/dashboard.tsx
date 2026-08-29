import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { BadgeCheck, Layers, ShieldCheck, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMerchantOrders, useMerchantProfile, useMerchantBalances } from '../lib/merchant-api';
import { formatDate } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

function StatCard({
  label,
  icon,
  loading,
  value,
  hint,
}: {
  label: string;
  icon: ReactNode;
  loading?: boolean;
  value: ReactNode;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const profile = useMerchantProfile();
  const balances = useMerchantBalances();
  const recent = useMerchantOrders({ limit: 5 });

  const b = balances.data;
  const stats: { label: string; value: ReactNode; hint: string; icon: LucideIcon }[] = [
    {
      label: 'Pending payout',
      value: b ? formatGhs(b.payablePesewas) : '—',
      hint: 'Net owed to you',
      icon: Wallet,
    },
    {
      label: 'Reserve held',
      value: b ? formatGhs(b.reserveHeldPesewas) : '—',
      hint: 'Default buffer',
      icon: ShieldCheck,
    },
    {
      label: 'Lifetime settled',
      value: b ? formatGhs(b.lifetimeSettledPesewas) : '—',
      hint: 'Paid out to date',
      icon: BadgeCheck,
    },
    {
      label: 'Active plans',
      value: b ? String(b.activePlans) : '—',
      hint: 'In repayment',
      icon: Layers,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={profile.data?.business_name}
        actions={profile.data ? <StatusBadge status={profile.data.status} /> : null}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <StatCard
            key={s.label}
            label={s.label}
            icon={<s.icon className="size-4 text-primary" />}
            loading={balances.isPending}
            value={s.value}
            hint={s.hint}
          />
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent orders</CardTitle>
          <Link to="/orders" className="text-sm text-primary underline-offset-4 hover:underline">
            View all
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {recent.isPending ? (
            <LoadingState />
          ) : recent.isError ? (
            <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
          ) : (recent.data?.rows ?? []).length === 0 ? (
            <EmptyState message="No orders yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Placed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent.data?.rows ?? []).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <Link to={`/orders/${o.id}`} className="hover:underline">
                        {o.order_number}
                      </Link>
                    </TableCell>
                    <TableCell>{formatGhs(o.total_pesewas)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {o.payment_type === 'installment' ? 'Instalments' : 'Pay now'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(o.placed_at ?? o.created_at)}
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
