import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, Skeleton, StatusBadge } from '@installment/ui';
import { Activity, ClipboardList, PhoneCall, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TelcoHealth, TelcoHealthStatus } from '@installment/api-types';
import { useApplications, useTelcoHealth } from '../lib/admin-api';
import { useMerchants } from '../lib/merchants-api';
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
          value="—"
          hint="Awaiting collections HTTP endpoints"
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
