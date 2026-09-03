import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import type { MerchantStats, MerchantStatsDay } from '@installment/api-types';
import { useMerchantStats } from '../lib/merchant-api';
import { PageHeader } from '../components/page-header';
import { ErrorState } from '../components/data-states';

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

/** `+18.0%`, `−4.2%`, or the honest thing when there is no baseline. */
function Delta({ pct, suffix }: { pct: number | null; suffix: string }) {
  if (pct === null) {
    return <span className="text-xs text-muted-foreground">no prior period to compare</span>;
  }
  const up = pct >= 0;
  return (
    <span className={up ? 'text-xs text-success' : 'text-xs text-destructive'}>
      {up ? '+' : '−'}
      {Math.abs(pct)}% {suffix}
    </span>
  );
}

function Tile({
  label,
  value,
  delta,
  hint,
  loading,
}: {
  label: string;
  value: string;
  delta?: React.ReactNode;
  hint?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        )}
        <div className="mt-1">{delta}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Sales by day.
 *
 * Deliberately plain: bars scaled against the busiest day, with the day's
 * takings on hover. The API returns every day in the window including the empty
 * ones, so a quiet Tuesday is a gap in the chart rather than a day that is not
 * drawn — which is the difference between "we sold nothing" and "we did not
 * look".
 */
function DailyBars({ days }: { days: MerchantStatsDay[] }) {
  const peak = Math.max(1, ...days.map((d) => d.grossSoldPesewas));
  // 90 bars at 390px is under 4px each; label only the ends at that density.
  const dense = days.length > 14;

  return (
    <div className="flex h-40 items-end gap-[2px]" role="img" aria-label="Sales by day">
      {days.map((d, i) => (
        <div key={d.date} className="flex flex-1 flex-col items-center justify-end gap-1">
          <div
            className={
              d.grossSoldPesewas > 0 ? 'w-full rounded-t bg-primary' : 'w-full rounded-t bg-muted'
            }
            style={{
              height: `${Math.max(2, Math.round((d.grossSoldPesewas / peak) * 100))}%`,
            }}
            title={`${d.date} · ${formatGhs(d.grossSoldPesewas)} · ${d.orders} order${d.orders === 1 ? '' : 's'}`}
          />
          {!dense || i === 0 || i === days.length - 1 ? (
            <span className="text-[10px] text-muted-foreground">{d.date.slice(5)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Tiles({ stats, loading }: { stats?: MerchantStats; loading: boolean }) {
  const c = stats?.current;
  const ch = stats?.change;
  const dash = '—';

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Sold"
        value={c ? formatGhs(c.grossSoldPesewas) : dash}
        delta={ch ? <Delta pct={ch.grossSoldPct} suffix="vs previous" /> : null}
        loading={loading}
      />
      <Tile
        label="Yours after fees"
        value={c ? formatGhs(c.netEarnedPesewas) : dash}
        delta={ch ? <Delta pct={ch.netEarnedPct} suffix="vs previous" /> : null}
        hint="On this period's sales, after MDR or commission and reserve"
        loading={loading}
      />
      <Tile
        label="Orders"
        value={c ? String(c.orders) : dash}
        delta={ch ? <Delta pct={ch.ordersPct} suffix="vs previous" /> : null}
        loading={loading}
      />
      <Tile
        label="Average basket"
        value={c ? formatGhs(c.averageBasketPesewas) : dash}
        delta={ch ? <Delta pct={ch.averageBasketPct} suffix="vs previous" /> : null}
        loading={loading}
      />
    </div>
  );
}

export function AnalyticsPage() {
  const [days, setDays] = useState<Window>(7);
  const stats = useMerchantStats(days);
  const s = stats.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="What your shop sold, and what of it is yours"
        actions={
          <div className="flex gap-1 rounded-lg border border-border p-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setDays(w)}
                aria-pressed={days === w}
                className={
                  days === w
                    ? 'rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground'
                    : 'rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-muted'
                }
              >
                {w} days
              </button>
            ))}
          </div>
        }
      />

      {stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      ) : null}

      <Tiles stats={s} loading={stats.isPending} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sales by day</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.isPending ? <Skeleton className="h-40 w-full" /> : null}
          {s ? <DailyBars days={s.daily} /> : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Abandoned checkouts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-2xl font-semibold tracking-tight">
              {s ? s.current.cancelledOrders : '—'}
            </div>
            <p className="text-sm text-muted-foreground">
              {s ? formatGhs(s.current.cancelledValuePesewas) : '—'} of orders raised and never paid
              for.
            </p>
            {/* Naming it precisely, because "cancellations" would read as a
                fulfilment problem. An order that has been paid for cannot be
                cancelled at all in this system — that is a refund, and it does
                not pass through here. */}
            <p className="text-xs text-muted-foreground">
              A paid order cannot be cancelled; those are refunds, and they are not counted here.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credited to you</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-2xl font-semibold tracking-tight">
              {s ? formatGhs(s.current.creditedPesewas) : '—'}
            </div>
            <p className="text-sm text-muted-foreground">
              Everything that landed in your account in this period, whatever it was for.
            </p>
            {/* Not the same number as "yours after fees" above, and the
                difference is the point: reserve released this week belongs to a
                sale from months ago. This is the figure that reconciles with
                the statement. */}
            <p className="text-xs text-muted-foreground">
              Includes reserve released from earlier sales, so it will not match “yours after fees”.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
