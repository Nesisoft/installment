import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@installment/ui';
import {
  REFUND_QUEUES,
  formatGhs,
  type RefundListRow,
  type RefundQueue,
} from '@installment/api-types';
import { apiErrorMessage, newIdempotencyKey } from '@installment/web-kit';
import {
  useMarkRefundPaid,
  useRefundSummary,
  useRefunds,
  useSendRefund,
} from '../../lib/refunds-api';
import { REFUND_QUEUE_INFO, refundAction } from '../../lib/refunds';
import { formatDateTime, waitingFor } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE = 50;

/** Who the money is for, and a way to the plan or order behind it. */
function OwedTo({ row }: { row: RefundListRow }) {
  const who = row.customer_name ?? 'Unknown customer';
  const link: ReactNode = row.customer_plan_id ? (
    <Link to={`/plans/${row.customer_plan_id}`} className="text-primary hover:underline">
      Instalment refund
    </Link>
  ) : row.order_id ? (
    <Link to={`/orders/${row.order_id}`} className="text-primary hover:underline">
      Return on {row.order_number ?? 'order'}
    </Link>
  ) : (
    'Refund'
  );
  return (
    <div className="space-y-0.5">
      <div className="font-medium">{who}</div>
      <div className="text-xs text-muted-foreground">{link}</div>
    </div>
  );
}

export function RefundsPage() {
  const [queue, setQueue] = useState<RefundQueue | ''>('');
  const [page, setPage] = useState(0);
  const summary = useRefundSummary();
  const list = useRefunds({
    ...(queue ? { queue } : {}),
    limit: PAGE,
    offset: page * PAGE,
  });
  const send = useSendRefund();
  const markPaid = useMarkRefundPaid();

  // One Idempotency-Key per attempt at one action on one refund, reused if
  // that attempt is retried, dropped once it succeeds.
  const keys = useRef(new Map<string, string>());
  const keyFor = (action: string, reference: string) => {
    const id = `${action}:${reference}`;
    let key = keys.current.get(id);
    if (!key) {
      key = newIdempotencyKey(`refund-${action}`);
      keys.current.set(id, key);
    }
    return key;
  };

  const [paying, setPaying] = useState<RefundListRow | null>(null);
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const needsCheck = paying ? refundAction(paying) === 'mark_paid_after_check' : false;

  function choose(next: RefundQueue | '') {
    setQueue(next);
    setPage(0);
  }

  function onSend(row: RefundListRow) {
    send.reset();
    send.mutate(
      { reference: row.reference, idempotencyKey: keyFor('send', row.reference) },
      { onSuccess: () => keys.current.delete(`send:${row.reference}`) },
    );
  }

  function onMarkPaid(e: FormEvent) {
    e.preventDefault();
    if (!paying || !note.trim() || (needsCheck && !checked)) return;
    const reference = paying.reference;
    markPaid.mutate(
      {
        reference,
        input: { note: note.trim(), ...(needsCheck ? { checked_paystack: true } : {}) },
        idempotencyKey: keyFor('paid', reference),
      },
      {
        onSuccess: () => {
          keys.current.delete(`paid:${reference}`);
          setPaying(null);
          setNote('');
        },
      },
    );
  }

  const totals = new Map((summary.data ?? []).map((t) => [t.queue, t]));
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds"
        description="Money owed back to customers, and where each refund stands."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REFUND_QUEUES.map((q) => {
          const info = REFUND_QUEUE_INFO[q];
          const t = totals.get(q);
          const urgent = info.attention && (t?.count ?? 0) > 0;
          return (
            <button
              key={q}
              type="button"
              onClick={() => choose(queue === q ? '' : q)}
              className={cn(
                'rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40',
                queue === q && 'border-primary ring-1 ring-primary',
                urgent && queue !== q && 'border-warning/60',
              )}
              aria-pressed={queue === q}
            >
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={q} tone={info.tone} label={info.label} />
                <span className="text-xl font-semibold tabular-nums">{t?.count ?? '—'}</span>
              </div>
              <p className="mt-2 text-sm font-medium">
                {t ? formatGhs(t.amount_pesewas) : '—'}
                {t && t.count > 0 && q !== 'paid' ? (
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    · oldest waiting {waitingFor(t.oldest_requested_at)}
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{info.detail}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {queue ? REFUND_QUEUE_INFO[queue].label : 'All refunds'}
          </CardTitle>
          {queue ? (
            <Button variant="ghost" size="sm" onClick={() => choose('')}>
              Show all
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState message="No refunds here." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>For</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Where it stands</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const info = REFUND_QUEUE_INFO[row.queue];
                  const action = refundAction(row);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <OwedTo row={row} />
                      </TableCell>
                      <TableCell className="font-medium tabular-nums">
                        {formatGhs(row.amount_pesewas)}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <StatusBadge status={row.queue} tone={info.tone} label={info.label} />
                          {row.last_error && row.queue !== 'paid' ? (
                            <p className="max-w-xs text-xs text-muted-foreground">
                              {row.last_error}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <div>{formatDateTime(row.requested_at)}</div>
                        {row.queue !== 'paid' ? (
                          <div className="text-xs">waiting {waitingFor(row.requested_at)}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        <div>{row.reference}</div>
                        {row.provider_transaction_reference ? (
                          <div title="The charge, as Paystack knows it">
                            charge {row.provider_transaction_reference}
                          </div>
                        ) : null}
                        {row.paystack_refund_id ? (
                          <div title="The refund Paystack holds for it">
                            Paystack refund {row.paystack_refund_id}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {action === 'send' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={send.isPending}
                            onClick={() => onSend(row)}
                          >
                            Send now
                          </Button>
                        ) : action === 'mark_paid' || action === 'mark_paid_after_check' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              markPaid.reset();
                              setNote('');
                              setChecked(false);
                              setPaying(row);
                            }}
                          >
                            Mark paid by hand
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {send.isError ? (
            <p className="px-6 py-3 text-sm text-destructive">{apiErrorMessage(send.error)}</p>
          ) : send.data ? (
            <p className="px-6 py-3 text-sm text-muted-foreground">
              {send.data.reference}: {send.data.outcome.replace('_', ' ')}
              {send.data.reason ? ` — ${send.data.reason}` : ''}
            </p>
          ) : null}
          {total > PAGE ? (
            <div className="flex items-center justify-between border-t border-border px-6 py-3 text-sm">
              <span className="text-muted-foreground">
                {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {paying ? (
        <Card className="border-warning/60">
          <CardHeader>
            <CardTitle className="text-base">
              Mark {formatGhs(paying.amount_pesewas)} to {paying.customer_name ?? 'the customer'} as
              paid by hand
            </CardTitle>
            <CardDescription>
              {paying.queue === 'failed'
                ? 'Paystack refused this refund. Only mark it paid once the customer has the money some other way — a Mobile Money transfer, a bank transfer, cash.'
                : needsCheck
                  ? 'Nobody knows whether this refund reached Paystack. Look the original charge up in the Paystack dashboard first. If it shows a refund, do nothing: the reconciler will pick it up. Only if it carries no refund, pay the customer another way and record it here.'
                  : 'This money came in outside Paystack. Mark it paid once it has gone back the same way.'}{' '}
              This books the refund as settled and cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onMarkPaid} className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1 space-y-2">
                <Label htmlFor="refund-note">How was it paid?</Label>
                <Input
                  id="refund-note"
                  required
                  maxLength={300}
                  placeholder="e.g. MoMo transfer to 024…, ref 7781"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              {needsCheck ? (
                <label className="flex w-full items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  <span>
                    I looked charge{' '}
                    <span className="font-mono text-xs">
                      {paying.provider_transaction_reference ?? '(no charge reference)'}
                    </span>{' '}
                    up in the Paystack dashboard and it carries no refund.
                  </span>
                </label>
              ) : null}
              <Button
                type="submit"
                disabled={markPaid.isPending || !note.trim() || (needsCheck && !checked)}
              >
                {markPaid.isPending ? 'Saving…' : 'Mark paid'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPaying(null)}>
                Cancel
              </Button>
            </form>
            {markPaid.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(markPaid.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
