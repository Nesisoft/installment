import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Card,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { useCollectionsCases } from '../../lib/collections-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const STAGES = [
  { value: '', label: 'All stages' },
  { value: 'soft_reminder', label: 'Soft reminder' },
  { value: 'firm_reminder', label: 'Firm reminder' },
  { value: 'restriction_warning', label: 'Restriction warning' },
  { value: 'agent_assigned', label: 'Agent assigned' },
  { value: 'field_visit', label: 'Field visit' },
  { value: 'legal_threat', label: 'Legal threat' },
  { value: 'write_off', label: 'Write off' },
];

export function CollectionsListPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState('');
  const [open, setOpen] = useState('true');

  const { data, isPending, isError, error, refetch } = useCollectionsCases({
    ...(stage ? { stage } : {}),
    open: open === 'true',
    limit: 100,
  });
  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Collections cases"
        description="Delinquency cases progressing through the dunning ladder."
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={open}
              onChange={(e) => setOpen(e.target.value)}
            >
              <option value="true">Open</option>
              <option value="false">Closed</option>
            </select>
          </div>
        }
      />

      <Card>
        {isPending ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="No cases match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Resolution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/collections/${c.id}`)}
                >
                  <TableCell>
                    <StatusBadge status={c.current_stage} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.customer_plan_id.slice(0, 8)}…
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(c.opened_at)}</TableCell>
                  <TableCell>
                    {c.assigned_agent_id ? (
                      <Badge variant="info">Assigned</Badge>
                    ) : (
                      <Badge variant="muted">Unassigned</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.resolution ? <StatusBadge status={c.resolution} /> : '—'}
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
