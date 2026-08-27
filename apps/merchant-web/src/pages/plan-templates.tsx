import {
  Badge,
  Card,
  formatStatusLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatBps, formatGhs } from '@installment/api-types';
import { useMerchantPlanTemplates } from '../lib/merchant-api';
import { PageHeader } from '../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

export function PlanTemplatesPage() {
  const templates = useMerchantPlanTemplates();
  const rows = templates.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan templates"
        description="The financing products available for your orders."
      />

      <Card>
        {templates.isPending ? (
          <LoadingState />
        ) : templates.isError ? (
          <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="No active plan templates." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Amount range</TableHead>
                <TableHead>Interest</TableHead>
                <TableHead>Down payment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    {t.name}
                    {!t.is_active ? (
                      <Badge variant="muted" className="ml-2">
                        Inactive
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{formatStatusLabel(t.business_model)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.number_of_installments} × {t.installment_frequency_days}d
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatGhs(t.min_amount_pesewas)} – {formatGhs(t.max_amount_pesewas)}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatBps(t.interest_rate_bps)}</TableCell>
                  <TableCell className="tabular-nums">{formatBps(t.down_payment_bps)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
