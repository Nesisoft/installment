import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  formatStatusLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatBps, formatGhs, type BusinessModel } from '@installment/api-types';
import { Plus } from 'lucide-react';
import { usePlanTemplates } from '../../lib/plan-templates-api';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const MODELS: { value: '' | BusinessModel; label: string }[] = [
  { value: '', label: 'All models' },
  { value: 'bnpl', label: 'BNPL' },
  { value: 'layaway', label: 'Layaway' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'rent_to_own', label: 'Rent to own' },
];

export function PlanTemplatesListPage() {
  const navigate = useNavigate();
  const [model, setModel] = useState('');
  const [active, setActive] = useState('');

  const { data, isPending, isError, error, refetch } = usePlanTemplates({
    ...(model ? { business_model: model } : {}),
    ...(active !== '' ? { is_active: active === 'true' } : {}),
    limit: 100,
  });
  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan templates"
        description="Configurable financing products merchants can offer."
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={active}
              onChange={(e) => setActive(e.target.value)}
            >
              <option value="">Any state</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
            <Button size="sm" onClick={() => navigate('/templates/new')}>
              <Plus />
              New template
            </Button>
          </div>
        }
      />

      <Card>
        {isPending ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="No plan templates match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Amount range</TableHead>
                <TableHead>Interest</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow
                  key={t.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/templates/${t.id}`)}
                >
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{formatStatusLabel(t.business_model)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.number_of_installments} × {t.installment_frequency_days}d
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatGhs(t.min_amount_pesewas)} – {formatGhs(t.max_amount_pesewas)}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatBps(t.interest_rate_bps)}</TableCell>
                  <TableCell>
                    <Badge variant={t.is_active ? 'success' : 'muted'}>
                      {t.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
