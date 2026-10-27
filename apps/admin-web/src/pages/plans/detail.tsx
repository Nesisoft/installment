import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
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
} from '@installment/ui';
import {
  defaultPlanSchema,
  formatGhs,
  ghsToPesewas,
  type InstallmentScheduleRow,
  type InstallmentStatus,
  type RefundMode,
} from '@installment/api-types';
import { apiErrorMessage, useApi } from '@installment/web-kit';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  useDefaultPlan,
  usePlan,
  usePlanSchedule,
  usePlanSettlement,
  useRecordManualPayment,
  useRefundInstallment,
} from '../../lib/plans-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const TERMINAL: InstallmentStatus[] = ['paid', 'refunded', 'waived', 'defaulted', 'restructured'];
function isPayable(status: InstallmentStatus): boolean {
  return !TERMINAL.includes(status);
}

/** `YYYY-MM-DD`, a week from today — the server's own default for re-collecting. */
function aWeekFromToday(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const REFUND_CHOICES: { mode: RefundMode; title: string; detail: string }[] = [
  {
    mode: 'forgive',
    title: 'Refund and forgive',
    detail:
      'The customer gets their money back and does not owe this instalment again. The seller gives back what they were paid for it. For a cancellation or a return.',
  },
  {
    mode: 'recollect',
    title: 'Refund and re-collect',
    detail:
      'The customer gets their money back and still owes it: a new instalment for the same amount is scheduled. For a charge taken from the wrong account.',
  },
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

export function PlanDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const plan = usePlan(id);
  const schedule = usePlanSchedule(id);
  const settlement = usePlanSettlement(id);
  const recordPayment = useRecordManualPayment(id);
  const refund = useRefundInstallment(id);
  const defaultPlan = useDefaultPlan(id);

  const [writeOff, setWriteOff] = useState({ reason: '', amount: '' });
  // The instalment being refunded, and how. One refund was all there was, and
  // it put the debt back with nothing left to collect it — so it asks now.
  const [refunding, setRefunding] = useState<InstallmentScheduleRow | null>(null);
  const [refundForm, setRefundForm] = useState<{
    mode: RefundMode;
    reason: string;
    dueDate: string;
  }>({ mode: 'forgive', reason: '', dueDate: aWeekFromToday() });
  const [formError, setFormError] = useState<string | null>(null);

  if (plan.isPending) return <LoadingState />;
  if (plan.isError) return <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />;

  const p = plan.data;

  function onRecord(row: InstallmentScheduleRow) {
    if (
      !window.confirm(
        `Record a manual payment for installment #${row.sequence_number} (${formatGhs(row.amount_due_pesewas)})?`,
      )
    ) {
      return;
    }
    recordPayment.mutate({ scheduleId: row.id, input: { provider_reference: 'manual' } });
  }

  function onRefund(row: InstallmentScheduleRow) {
    refund.reset();
    setRefundForm({ mode: 'forgive', reason: '', dueDate: aWeekFromToday() });
    setRefunding(row);
  }

  function confirmRefund(e: FormEvent) {
    e.preventDefault();
    if (!refunding) return;
    refund.mutate(
      {
        scheduleId: refunding.id,
        input: {
          mode: refundForm.mode,
          ...(refundForm.reason.trim() ? { reason: refundForm.reason.trim() } : {}),
          ...(refundForm.mode === 'recollect' ? { due_date: refundForm.dueDate } : {}),
        },
      },
      { onSuccess: () => setRefunding(null) },
    );
  }

  async function viewReceipt(scheduleId: string) {
    const { data } = await api.get<string>(`/admin/installments/${scheduleId}/receipt.html`, {
      responseType: 'text',
    });
    const url = URL.createObjectURL(new Blob([data], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
  }

  function onWriteOff(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      ...(writeOff.reason ? { reason: writeOff.reason } : {}),
      ...(writeOff.amount
        ? { unrecoveredAmountPesewas: ghsToPesewas(Number(writeOff.amount)) }
        : {}),
    };
    const parsed = defaultPlanSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the write-off details');
      return;
    }
    if (
      !window.confirm('Write this plan off as defaulted? This books the loss and cannot be undone.')
    ) {
      return;
    }
    defaultPlan.mutate(parsed.data, { onSuccess: () => setWriteOff({ reason: '', amount: '' }) });
  }

  // A refund's error shows in its own panel, beside the choice that caused it.
  const actionError = recordPayment.error ?? (refunding ? null : refund.error);

  return (
    <div className="space-y-6">
      <Link
        to="/plans"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Plan lookup
      </Link>

      <PageHeader
        title="Plan"
        description={`${formatGhs(p.order_amount_pesewas)} · ${p.business_model} · ${p.number_of_installments} installments`}
        actions={<StatusBadge status={p.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Order amount" value={formatGhs(p.order_amount_pesewas)} />
            <Field label="Financed" value={formatGhs(p.financed_amount_pesewas)} />
            <Field label="Total payable" value={formatGhs(p.total_payable_pesewas)} />
            <Field label="Outstanding" value={formatGhs(p.outstanding_pesewas)} />
            <Field label="Down payment" value={formatGhs(p.down_payment_pesewas)} />
            <Field label="Activated" value={formatDate(p.activated_at)} />
            <Field label="Customer" value={p.customer_id} />
            <Field label="Merchant" value={p.merchant_id} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settlement footprint</CardTitle>
        </CardHeader>
        <CardContent>
          {settlement.isPending ? (
            <LoadingState label="Loading…" />
          ) : settlement.isError ? (
            <ErrorState error={settlement.error} onRetry={() => void settlement.refetch()} />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Gross accrued" value={formatGhs(settlement.data.grossAccruedPesewas)} />
              <Field label="Refunded" value={formatGhs(settlement.data.refundedPesewas)} />
              <Field label="Reserve held" value={formatGhs(settlement.data.reserveHeldPesewas)} />
              <Field
                label="Default written off"
                value={formatGhs(settlement.data.defaultWrittenOffPesewas)}
              />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule</CardTitle>
          <CardDescription>
            Record out-of-band payments or refund a paid installment.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {schedule.isPending ? (
            <LoadingState />
          ) : schedule.isError ? (
            <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />
          ) : (schedule.data ?? []).length === 0 ? (
            <EmptyState message="No installments." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(schedule.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.sequence_number}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(row.due_date)}
                    </TableCell>
                    <TableCell>{formatGhs(row.amount_due_pesewas)}</TableCell>
                    <TableCell>{formatGhs(row.amount_paid_pesewas)}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {isPayable(row.status) ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={recordPayment.isPending}
                            onClick={() => onRecord(row)}
                          >
                            Record payment
                          </Button>
                        ) : null}
                        {row.status === 'paid' ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void viewReceipt(row.id)}
                            >
                              <ExternalLink />
                              Receipt
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={refund.isPending}
                              onClick={() => onRefund(row)}
                            >
                              Refund
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {actionError ? (
            <p className="px-6 py-3 text-sm text-destructive">{apiErrorMessage(actionError)}</p>
          ) : null}
        </CardContent>
      </Card>

      {refunding ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">
              Refund installment #{refunding.sequence_number} (
              {formatGhs(refunding.amount_paid_pesewas)})
            </CardTitle>
            <CardDescription>
              The money goes back to the customer either way. Choose what happens to the debt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={confirmRefund} className="space-y-4">
              <fieldset className="space-y-3">
                {REFUND_CHOICES.map((c) => (
                  <label key={c.mode} className="flex cursor-pointer gap-3 text-sm">
                    <input
                      type="radio"
                      name="refund-mode"
                      className="mt-1"
                      checked={refundForm.mode === c.mode}
                      onChange={() => setRefundForm((f) => ({ ...f, mode: c.mode }))}
                    />
                    <span>
                      <span className="font-medium">{c.title}</span>
                      <span className="block text-muted-foreground">{c.detail}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-wrap items-end gap-3">
                {refundForm.mode === 'recollect' ? (
                  <div className="space-y-2">
                    <Label htmlFor="refund-due">Collect again on</Label>
                    <Input
                      id="refund-due"
                      type="date"
                      value={refundForm.dueDate}
                      onChange={(e) => setRefundForm((f) => ({ ...f, dueDate: e.target.value }))}
                    />
                  </div>
                ) : null}
                <div className="flex-1 space-y-2">
                  <Label htmlFor="refund-reason">Reason (optional)</Label>
                  <Input
                    id="refund-reason"
                    value={refundForm.reason}
                    onChange={(e) => setRefundForm((f) => ({ ...f, reason: e.target.value }))}
                  />
                </div>
                <Button type="submit" variant="destructive" disabled={refund.isPending}>
                  {refund.isPending ? 'Refunding…' : 'Refund'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setRefunding(null)}>
                  Cancel
                </Button>
              </div>
              {refund.isError ? (
                <p className="text-sm text-destructive">{apiErrorMessage(refund.error)}</p>
              ) : null}
            </form>
          </CardContent>
        </Card>
      ) : null}

      {p.status === 'active' ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Write off</CardTitle>
            <CardDescription>
              Mark the plan defaulted and book the loss across reserve / merchant / platform.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onWriteOff} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label>Reason (optional)</Label>
                <Input
                  value={writeOff.reason}
                  onChange={(e) => setWriteOff((s) => ({ ...s, reason: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Unrecovered amount (GHS, optional)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={writeOff.amount}
                  onChange={(e) => setWriteOff((s) => ({ ...s, amount: e.target.value }))}
                  placeholder="Defaults to outstanding"
                />
              </div>
              <Button type="submit" variant="destructive" disabled={defaultPlan.isPending}>
                {defaultPlan.isPending ? 'Writing off…' : 'Write off plan'}
              </Button>
            </form>
            {formError ? <p className="mt-3 text-sm text-destructive">{formError}</p> : null}
            {defaultPlan.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(defaultPlan.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
