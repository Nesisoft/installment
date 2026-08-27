import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
  cn,
} from '@installment/ui';
import { formatGhs, type InstallmentScheduleRow } from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey, useApi } from '@installment/web-kit';
import { ArrowLeft, CalendarClock, ExternalLink, Smartphone } from 'lucide-react';
import { usePayMomo, usePlanSchedule, usePlans } from '../lib/shop-api';
import { formatDate, relativeDay } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

const PAYABLE_EXCLUDED = new Set(['paid', 'refunded', 'waived', 'defaulted', 'restructured']);

/** The next instalment a customer would sensibly pay. */
function nextDue(rows: InstallmentScheduleRow[]): InstallmentScheduleRow | null {
  const open = rows
    .filter((r) => !PAYABLE_EXCLUDED.has(r.status))
    .sort((a, b) => a.sequence_number - b.sequence_number);
  return open[0] ?? null;
}

export function PlansPage() {
  const plans = usePlans();

  if (plans.isPending) return <LoadingState />;
  if (plans.isError) return <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />;

  const rows = plans.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Your plans</h1>
      {rows.length === 0 ? (
        <EmptyState message="You have no instalment plans yet." />
      ) : (
        <ul className="space-y-3">
          {rows.map((p) => (
            <li key={p.id}>
              <Link to={`/plans/${p.id}`}>
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {formatGhs(p.order_amount_pesewas)} order
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {p.number_of_installments} instalments · every{' '}
                          {p.installment_frequency_days} days
                        </p>
                      </div>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Still to pay</span>
                      <span className="text-sm font-semibold">
                        {formatGhs(p.outstanding_pesewas)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlanDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const plans = usePlans();
  const schedule = usePlanSchedule(id);
  const payMomo = usePayMomo(id);

  /**
   * One idempotency key per instalment, retired only once that instalment is
   * actually paid.
   *
   * A failed attempt must KEEP its key. The case that matters is a charge that
   * succeeded on the server while the response was lost — routine on a mobile
   * connection. The customer sees an error and taps Pay again; reusing the key
   * replays the original charge instead of debiting them a second time.
   *
   * Keyed per instalment rather than one key for the plan, because the server
   * binds a key to a hash of the request path. Reusing one key across two
   * instalments would make the second payment a 409 conflict.
   */
  const payKeys = useRef<Record<string, string>>({});
  const [paying, setPaying] = useState<string | null>(null);

  const plan = (plans.data ?? []).find((p) => p.id === id) ?? null;
  const rows = useMemo(
    () => (schedule.data ?? []).slice().sort((a, b) => a.sequence_number - b.sequence_number),
    [schedule.data],
  );
  const next = nextDue(rows);

  async function openReceipt(scheduleId: string) {
    const { data } = await api.get<string>(`/me/installments/${scheduleId}/receipt.html`, {
      responseType: 'text',
    });
    const url = URL.createObjectURL(new Blob([data], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
  }

  function onPay(scheduleId: string) {
    setPaying(scheduleId);
    const key = payKeys.current[scheduleId] ?? newIdempotencyKey(`pay-${scheduleId}`);
    payKeys.current[scheduleId] = key;
    payMomo.mutate(
      { scheduleId, idempotencyKey: key },
      {
        // Only a charge that came back successful retires its key. Anything
        // else keeps it, so the next tap is deduplicated rather than charged.
        onSuccess: () => {
          delete payKeys.current[scheduleId];
        },
        onSettled: () => setPaying(null),
      },
    );
  }

  if (schedule.isPending) return <LoadingState />;
  if (schedule.isError)
    return <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />;

  return (
    <div className="space-y-5">
      <Link
        to="/plans"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to plans
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Your plan</h1>
          {plan ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {formatGhs(plan.order_amount_pesewas)} order · {plan.number_of_installments}{' '}
              instalments
            </p>
          ) : null}
        </div>
        {plan ? <StatusBadge status={plan.status} /> : null}
      </div>

      {plan ? (
        <section className="rounded-lg bg-primary p-5 text-primary-foreground shadow-sm">
          <p className="text-sm text-primary-foreground/80">Still to pay</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {formatGhs(plan.outstanding_pesewas)}
          </p>
          {next ? (
            <p className="mt-2 text-sm text-primary-foreground/80">
              Next: {formatGhs(next.amount_due_pesewas)} due {formatDate(next.due_date)} (
              {relativeDay(next.due_date)})
            </p>
          ) : (
            <p className="mt-2 text-sm text-primary-foreground/80">All instalments settled.</p>
          )}
        </section>
      ) : null}

      {next ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="size-4 text-primary" />
              Pay with Mobile Money
            </CardTitle>
            <CardDescription>
              Charges the MoMo number saved on your account. You will get a prompt on your phone.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {payMomo.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(payMomo.error)}</p>
            ) : null}
            {payMomo.isSuccess ? (
              <p className="text-sm text-success">
                Payment started — approve the prompt on your phone.
              </p>
            ) : null}
            <Button
              className="w-full"
              size="lg"
              disabled={payMomo.isPending}
              onClick={() => onPay(next.id)}
            >
              {payMomo.isPending && paying === next.id
                ? 'Starting…'
                : `Pay ${formatGhs(next.amount_due_pesewas)} now`}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="size-4 text-primary" />
            Payment schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No instalments yet.</p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className={cn(
                  'flex items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    #{row.sequence_number} · {formatGhs(row.amount_due_pesewas)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Due {formatDate(row.due_date)}
                    {row.status === 'paid' && row.paid_at
                      ? ` · paid ${formatDate(row.paid_at)}`
                      : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={row.status} />
                  {row.status === 'paid' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => void openReceipt(row.id)}
                    >
                      <ExternalLink />
                      Receipt
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
