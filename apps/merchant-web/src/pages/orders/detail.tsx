import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { useApi } from '@installment/web-kit';
import { ArrowLeft, Download, ExternalLink } from 'lucide-react';
import {
  useMerchantPlan,
  useMerchantPlanSchedule,
  useMerchantPlanSettlement,
} from '../../lib/merchant-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const plan = useMerchantPlan(id);
  const schedule = useMerchantPlanSchedule(id);
  const settlement = useMerchantPlanSettlement(id);

  async function openStatement(format: 'html' | 'csv') {
    const { data } = await api.get<string>(`/merchant/plans/${id}/statement.${format}`, {
      responseType: 'text',
    });
    const type = format === 'csv' ? 'text/csv' : 'text/html';
    const url = URL.createObjectURL(new Blob([data], { type }));
    if (format === 'csv') {
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${id}.csv`;
      a.click();
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  if (plan.isPending) return <LoadingState />;
  if (plan.isError) return <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />;
  const p = plan.data;

  return (
    <div className="space-y-6">
      <Link
        to="/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to orders
      </Link>

      <PageHeader
        title="Order"
        description={`${formatGhs(p.order_amount_pesewas)} · ${p.business_model} · ${p.number_of_installments} installments`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={p.status} />
            <Button variant="outline" size="sm" onClick={() => void openStatement('html')}>
              <ExternalLink />
              Statement
            </Button>
            <Button variant="outline" size="sm" onClick={() => void openStatement('csv')}>
              <Download />
              CSV
            </Button>
          </div>
        }
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
            <Field label="Completed" value={formatDate(p.completed_at)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your settlement on this order</CardTitle>
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
          <CardTitle className="text-base">Repayment schedule</CardTitle>
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
