import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import type {
  MerchantStats,
  MerchantStatsDay,
  MerchantStatsPaymentMix,
} from '@installment/api-types';
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
    <div className="flex h-40 gap-[2px]" role="img" aria-label="Sales by day">
      {days.map((d, i) => (
        <div key={d.date} className="flex flex-1 flex-col items-center">
          {/* The bar's height is a percentage, so it needs a parent with a
              height to be a percentage OF. `flex-1` inside this fixed-height
              column gives it one — against an auto-height parent every bar
              collapses to nothing, which is what it did. */}
          <div className="flex w-full flex-1 items-end">
            <div
              className={
                d.grossSoldPesewas > 0 ? 'w-full rounded-t bg-primary' : 'w-full rounded-t bg-muted'
              }
              style={{
                height: `${Math.max(2, Math.round((d.grossSoldPesewas / peak) * 100))}%`,
              }}
              title={`${d.date} · ${formatGhs(d.grossSoldPesewas)} · ${d.orders} order${d.orders === 1 ? '' : 's'}`}
            />
          </div>
          {/* Always the same height, labelled or not, so the bars stay on one
              baseline at 90-day density where most labels are dropped. */}
          <span className="h-4 text-[10px] leading-4 text-muted-foreground">
            {!dense || i === 0 || i === days.length - 1 ? d.date.slice(5) : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * How the period's sales split between paying over time and paying outright.
 *
 * One stacked bar rather than two numbers, because the useful question is the
 * proportion — a seller deciding whether instalments are worth offering. The
 * basket comparison underneath is the reason they usually are, and it is
 * computed here from the two sides rather than sent as its own figure: it is a
 * subtraction, and an API field that is only ever `a - b` is a field that can
 * disagree with `a` and `b`.
 */
function PaymentMix({ mix }: { mix: MerchantStatsPaymentMix }) {
  const { installment, full } = mix;
  const total = installment.orders + full.orders;
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">Nothing sold in this period yet.</p>;
  }

  const basketGap = installment.averageBasketPesewas - full.averageBasketPesewas;
  const rows = [
    { label: 'Paid in instalments', side: installment, className: 'bg-primary' },
    // A dark neutral rather than a pale one: the two sides always sum to 100%,
    // so the track is never visible, and a pale fill at 100% read as an empty
    // track rather than a full one.
    { label: 'Paid outright', side: full, className: 'bg-foreground/45' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {rows.map((r) =>
          r.side.orders === 0 ? null : (
            <div
              key={r.label}
              className={r.className}
              style={{ width: `${r.side.shareOfOrdersPct ?? 0}%` }}
              title={`${r.label}: ${r.side.orders} of ${total} orders`}
            />
          ),
        )}
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${r.className}`} />
            <div>
              <div className="text-sm font-semibold">
                {r.side.shareOfOrdersPct ?? 0}%
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {r.side.orders} order{r.side.orders === 1 ? '' : 's'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {r.label} · {formatGhs(r.side.averageBasketPesewas)} average
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Only worth a sentence when both sides exist to compare. */}
      {installment.orders > 0 && full.orders > 0 ? (
        <p className="text-sm text-muted-foreground">
          {basketGap === 0
            ? 'Both kinds of order carry the same average basket in your shop.'
            : `Instalment orders carry a ${formatGhs(Math.abs(basketGap))} ${
                basketGap > 0 ? 'higher' : 'lower'
              } average basket than paid-outright orders in your shop.`}
        </p>
      ) : null}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Instalments vs paid outright</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.isPending ? <Skeleton className="h-20 w-full" /> : null}
          {s ? <PaymentMix mix={s.current.paymentMix} /> : null}
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
