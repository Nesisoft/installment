import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, Skeleton, StatusBadge } from '@installment/ui';
import {
  Activity,
  BookCheck,
  ClipboardList,
  PhoneCall,
  ShoppingBag,
  Store,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { formatGhs, type TelcoHealth, type TelcoHealthStatus } from '@installment/api-types';
import { useApplications, useLedgerIntegrity, useTelcoHealth } from '../lib/admin-api';
import { useMerchants } from '../lib/merchants-api';
import { useCollectionsCases } from '../lib/collections-api';
import { useAdminOrderCounts } from '../lib/orders-api';
import { useRefundSummary } from '../lib/refunds-api';
import { REFUND_QUEUE_INFO } from '../lib/refunds';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';

const SAMPLE = 200;

function cap(n: number): string {
  return n >= SAMPLE ? `${SAMPLE}+` : String(n);
}

const SEVERITY: Record<TelcoHealthStatus, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

function worstTelco(rows: TelcoHealth[]): TelcoHealthStatus {
  return rows.reduce<TelcoHealthStatus>(
    (worst, r) => (SEVERITY[r.status] > SEVERITY[worst] ? r.status : worst),
    'healthy',
  );
}

function StatCard({
  label,
  icon,
  loading,
  value,
  hint,
  badge,
  to,
}: {
  label: string;
  icon: ReactNode;
  loading?: boolean;
  value: ReactNode;
  hint: string;
  badge?: ReactNode;
  to: string;
}) {
  return (
    <Link to={to} className="block">
      <Card className="transition-colors hover:border-primary/40">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          {icon}
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tracking-tight">{value}</span>
              {badge}
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

export function DashboardPage() {
  const pending = useApplications({ status: 'pending', limit: SAMPLE });
  const manual = useApplications({ status: 'manual_review', limit: SAMPLE });
  const merchants = useMerchants({ status: 'active', limit: SAMPLE });
  const telco = useTelcoHealth();
  const cases = useCollectionsCases({ open: true, limit: SAMPLE });
  const orderCounts = useAdminOrderCounts();
  const refunds = useRefundSummary();
  const ledger = useLedgerIntegrity();

  // Refunds a person has to act on: Paystack refused it, it has to be paid by
  // hand, or nobody knows whether it went.
  const owed = (refunds.data ?? []).filter((t) => REFUND_QUEUE_INFO[t.queue].attention);
  const owedCount = owed.reduce((n, t) => n + t.count, 0);
  const owedAmount = owed.reduce((n, t) => n + t.amount_pesewas, 0);
  const awaitingPayment =
    (orderCounts.data?.pending_payment ?? 0) + (orderCounts.data?.payment_failed ?? 0);

  const reviewCount = (pending.data?.length ?? 0) + (manual.data?.length ?? 0);
  const reviewLoading = pending.isPending || manual.isPending;

  const telcoRows = telco.data ?? [];
  const healthy = telcoRows.filter((t) => t.status === 'healthy').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations overview"
        description="Live queues and system health. Click any card to drill in."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          to="/applications"
          label="Applications to review"
          icon={<ClipboardList className="size-4 text-primary" />}
          loading={reviewLoading}
          value={cap(reviewCount)}
          hint="Pending + manual review"
        />
        <StatCard
          to="/collections"
          label="Open collections cases"
          icon={<PhoneCall className="size-4 text-primary" />}
          loading={cases.isPending}
          value={cap(cases.data?.length ?? 0)}
          hint="Customers behind on a plan"
        />
        <StatCard
          to="/orders"
          label="Orders awaiting payment"
          icon={<ShoppingBag className="size-4 text-primary" />}
          loading={orderCounts.isPending}
          value={awaitingPayment}
          hint="Pay-in-full orders not yet paid, or whose charge failed"
        />
        <StatCard
          to="/refunds"
          label="Refunds needing a person"
          icon={<Undo2 className="size-4 text-primary" />}
          loading={refunds.isPending}
          value={owedCount}
          badge={
            owedCount > 0 ? (
              <StatusBadge status="failed" tone="warning" label={formatGhs(owedAmount)} />
            ) : null
          }
          hint="Refused, to pay by hand, or unresolved"
        />
        <StatCard
          to="/merchants"
          label="Active merchants"
          icon={<Store className="size-4 text-primary" />}
          loading={merchants.isPending}
          value={cap(merchants.data?.length ?? 0)}
          hint="Onboarded & live"
        />
        <StatCard
          to="/telco-health"
          label="Telco health"
          icon={<Activity className="size-4 text-primary" />}
          loading={telco.isPending}
          value={`${healthy}/${telcoRows.length || 3}`}
          badge={telcoRows.length ? <StatusBadge status={worstTelco(telcoRows)} /> : null}
          hint="MoMo networks healthy"
        />
        <StatCard
          to="/ledger"
          label="Ledger"
          icon={<BookCheck className="size-4 text-primary" />}
          loading={ledger.isPending}
          value={ledger.isError ? '—' : ledger.data?.healthy ? 'Balanced' : 'Drifted'}
          badge={
            ledger.data && !ledger.data.healthy ? (
              <StatusBadge
                status="failed"
                label={`${ledger.data.unbalancedTransactions.length} unbalanced`}
              />
            ) : null
          }
          hint={
            ledger.isError
              ? 'Needs the audit:read permission'
              : ledger.data
                ? ledger.data.healthy
                  ? `Debits equal credits · checked ${formatDateTime(ledger.data.checkedAt)}`
                  : 'The books do not balance — open it'
                : 'Debits equal credits'
          }
        />
      </div>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Review queue</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Head to{' '}
          <Link to="/applications" className="text-primary underline-offset-4 hover:underline">
            Applications
          </Link>{' '}
          to score and decide, or{' '}
          <Link to="/telco-health" className="text-primary underline-offset-4 hover:underline">
            Telco health
          </Link>{' '}
          to watch the MoMo networks.
        </CardContent>
      </Card>
    </div>
  );
}
