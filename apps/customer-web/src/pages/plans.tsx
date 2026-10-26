import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  StatusBadge,
  cn,
} from '@installment/ui';
import {
  formatGhs,
  type CustomerPlan,
  type InstallmentScheduleRow,
  type MomoProvider,
} from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey, useApi } from '@installment/web-kit';
import { ArrowLeft, CalendarClock, ExternalLink, Smartphone, CreditCard } from 'lucide-react';
import {
  usePayMomo,
  usePlanSchedule,
  usePlans,
  usePayByCardLink,
  useSavedCards,
  useRemoveCard,
  useMomoOnFile,
} from '../lib/shop-api';
import { formatDate, relativeDay } from '../lib/format';
import { cadenceLabel } from '../lib/installment-preview';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

const PAYABLE_EXCLUDED = new Set(['paid', 'refunded', 'waived', 'defaulted', 'restructured']);

/**
 * Every payment on the plan, deposit included. `number_of_installments`
 * excludes the deposit, so a "Pay in 4" plan — a deposit and three more —
 * read "3 instalments" over a schedule of four.
 */
function paymentCount(plan: Pick<CustomerPlan, 'number_of_installments' | 'down_payment_pesewas'>) {
  return plan.number_of_installments + (plan.down_payment_pesewas > 0 ? 1 : 0);
}

/** What paying a row now takes: the instalment plus any late fee it has run up. */
function payable(row: Pick<InstallmentScheduleRow, 'amount_due_pesewas' | 'late_fee_pesewas'>) {
  return row.amount_due_pesewas + row.late_fee_pesewas;
}

const MOMO_PROVIDERS: { value: MomoProvider; label: string }[] = [
  { value: 'mtn', label: 'MTN' },
  { value: 'vod', label: 'Telecel' },
  { value: 'tgo', label: 'AirtelTigo' },
];

/** `024 000 0000` / `24 000 0000` -> `+233240000000`. */
function normaliseGhPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  const local = digits.startsWith('233') ? digits.slice(3) : digits.replace(/^0/, '');
  return `+233${local}`;
}

/** The next instalment a customer would sensibly pay. */
function nextDue(rows: InstallmentScheduleRow[]): InstallmentScheduleRow | null {
  const open = rows
    .filter((r) => !PAYABLE_EXCLUDED.has(r.status))
    .sort((a, b) => a.sequence_number - b.sequence_number);
  return open[0] ?? null;
}

/**
 * What is on file, and how to take it off.
 *
 * Shown wherever a customer looks at money they owe. Storing someone's card and
 * giving them no way to see or remove it is not a thing to defer: the point of
 * saving it is that we charge it without asking, which only works as a bargain
 * if they can end it.
 */
function SavedCards() {
  const cards = useSavedCards();
  const remove = useRemoveCard();

  const rows = cards.data ?? [];
  if (cards.isPending || rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-primary" />
          Saved cards
        </CardTitle>
        <CardDescription>
          We charge these automatically when an instalment is due. Remove one any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {remove.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(remove.error)}</p>
        ) : null}
        {rows.map((card) => (
          <div
            key={card.id}
            className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {card.brand ? card.brand.toUpperCase() : 'Card'} ···· {card.last4 ?? '????'}
              </p>
              <p className="text-xs text-muted-foreground">
                {card.exp_month && card.exp_year
                  ? `Expires ${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`
                  : 'Expiry unknown'}
                {card.is_usable ? ' · used for automatic payments' : null}
                {card.status === 'revoked' ? ' · your bank declined this card' : null}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate(card.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function PlansPage() {
  const plans = usePlans();

  if (plans.isPending) return <LoadingState />;
  if (plans.isError) return <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />;

  const rows = plans.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Your plans</h1>
      <SavedCards />
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
                          {paymentCount(p)} payments · every{' '}
                          {cadenceLabel(p.installment_frequency_days)}
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
  const cardLink = usePayByCardLink(id);
  const onFile = useMomoOnFile();
  const [momo, setMomo] = useState<{ phone: string; provider: MomoProvider } | null>(null);
  // The number to charge: what the customer typed, else what is on file.
  const number = momo ?? {
    phone: onFile.data?.momo_phone ?? '',
    provider: onFile.data?.momo_provider ?? 'mtn',
  };
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  /**
   * One idempotency key per attempt on an instalment.
   *
   * A request that got no answer must KEEP its key. The case that matters is a
   * charge that succeeded on the server while the response was lost — routine
   * on a mobile connection. The customer taps Pay again; reusing the key
   * replays the original charge instead of debiting them a second time.
   *
   * Any answer retires it, though: the answer is stored under the key, so a
   * retry would replay it. This kept the key after a decline (a 200 saying
   * `failed`), so the next tap replayed the decline. A different number or
   * network is a different request, so it gets its own key too — the server
   * hashes the body and answers a changed body under an old key with a 409.
   *
   * Keyed per instalment rather than one key for the plan, because the server
   * binds a key to a hash of the request path.
   */
  const payKeys = useRef<Record<string, { key: string; body: string }>>({});
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

  function onPayByCard(scheduleId: string) {
    cardLink.mutate(scheduleId, {
      onSuccess: ({ url }) => {
        // Paystack's own page: card entry and 3-D Secure never touch this app.
        window.location.assign(url);
      },
    });
  }

  function onPay(scheduleId: string) {
    setResult(null);
    if (number.phone.replace(/\D/g, '').length < 9) {
      setResult({ tone: 'error', text: 'Enter the Mobile Money number to charge.' });
      return;
    }
    setPaying(scheduleId);
    const phone = normaliseGhPhone(number.phone);
    const body = `${phone}:${number.provider}`;
    const held = payKeys.current[scheduleId];
    const key = held && held.body === body ? held.key : newIdempotencyKey(`pay-${scheduleId}`);
    payKeys.current[scheduleId] = { key, body };
    payMomo.mutate(
      { scheduleId, phone, provider: number.provider, idempotencyKey: key },
      {
        onSuccess: (charge) => {
          delete payKeys.current[scheduleId];
          // A decline is a 200 that says `failed`. This said "Payment started —
          // approve the prompt on your phone" whatever came back.
          if (charge.status === 'failed') {
            setResult({
              tone: 'error',
              text: 'That payment did not go through. Check the number and network, and that there is enough in the wallet, then try again.',
            });
          } else if (charge.status === 'succeeded' || charge.status === 'paid') {
            setResult({ tone: 'ok', text: 'Paid. Thank you.' });
          } else {
            setResult({ tone: 'ok', text: 'Check your phone and approve the prompt to pay.' });
          }
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
              {formatGhs(plan.order_amount_pesewas)} order · {paymentCount(plan)} payments
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
              Next: {formatGhs(payable(next))} due {formatDate(next.due_date)} (
              {relativeDay(next.due_date)})
              {next.late_fee_pesewas > 0
                ? ` · includes ${formatGhs(next.late_fee_pesewas)} late fee`
                : ''}
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
            {/* This charged "the MoMo number saved on your account" with no way
                to give one: an account opened on the web has none, and the
                server refused with "Mobile Money phone is required". */}
            <CardDescription>
              We send a prompt to this number; approve it on your phone.
              {onFile.data && !onFile.data.momo_phone
                ? ' The first number you pay with is kept for automatic collection.'
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input
                aria-label="Mobile Money number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="024 123 4567"
                value={number.phone}
                onChange={(e) => setMomo({ ...number, phone: e.target.value })}
              />
              <select
                aria-label="Network"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={number.provider}
                onChange={(e) => setMomo({ ...number, provider: e.target.value as MomoProvider })}
              >
                {MOMO_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {payMomo.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(payMomo.error)}</p>
            ) : null}
            {result ? (
              <p
                className={cn(
                  'text-sm',
                  result.tone === 'ok' ? 'text-success' : 'text-destructive',
                )}
              >
                {result.text}
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
                : `Pay ${formatGhs(payable(next))} now`}
            </Button>

            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {cardLink.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(cardLink.error)}</p>
            ) : null}
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              disabled={cardLink.isPending}
              onClick={() => onPayByCard(next.id)}
            >
              <CreditCard className="size-4" />
              {cardLink.isPending ? 'Opening…' : 'Pay by card'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Paying by card once lets us collect the rest automatically, so you will not be asked
              again.
            </p>
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
                    {plan && plan.down_payment_pesewas > 0 && row.sequence_number === 1
                      ? 'Deposit'
                      : `#${row.sequence_number}`}{' '}
                    · {formatGhs(row.amount_due_pesewas)}
                    {row.late_fee_pesewas > 0
                      ? ` + ${formatGhs(row.late_fee_pesewas)} late fee`
                      : ''}
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
