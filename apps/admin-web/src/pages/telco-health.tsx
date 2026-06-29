import { Button, Card, CardContent, CardHeader, CardTitle, StatusBadge } from '@installment/ui';
import { RefreshCw } from 'lucide-react';
import { useTelcoHealth } from '../lib/admin-api';
import { formatPercent } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

const TELCO_LABEL: Record<string, string> = {
  mtn: 'MTN MoMo',
  tgo: 'AirtelTigo Money',
  vod: 'Telecel Cash',
};

export function TelcoHealthPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useTelcoHealth();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Telco health"
        description="Mobile Money charge success per network over the rolling 15-minute window. Below 10 attempts the status is Unknown."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />

      {isPending ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((t) => (
            <Card key={t.telco}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">{TELCO_LABEL[t.telco] ?? t.telco}</CardTitle>
                <StatusBadge status={t.status} />
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-3xl font-semibold tracking-tight">
                    {formatPercent(t.successRate)}
                  </div>
                  <p className="text-xs text-muted-foreground">success rate</p>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Attempts</dt>
                    <dd className="font-medium">{t.attempts}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Success</dt>
                    <dd className="font-medium text-success">{t.successes}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Failed</dt>
                    <dd className="font-medium text-destructive">{t.failures}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
