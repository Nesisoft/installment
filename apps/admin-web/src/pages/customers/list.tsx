import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useCustomers } from '../../lib/customers-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE_SIZE = 25;

export function CustomersListPage() {
  const navigate = useNavigate();
  const [kyc, setKyc] = useState('');
  const [blocked, setBlocked] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isPending, isError, error, refetch, isFetching } = useCustomers({
    ...(kyc !== '' ? { kyc_tier: Number(kyc) } : {}),
    ...(blocked !== '' ? { is_on_blocklist: blocked === 'true' } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const rows = data ?? [];
  const hasNext = rows.length === PAGE_SIZE;

  function resetTo(setter: (v: string) => void, value: string) {
    setter(value);
    setOffset(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="End-user borrowers, their KYC tier and blocklist status."
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={kyc}
              onChange={(e) => resetTo(setKyc, e.target.value)}
            >
              <option value="">All tiers</option>
              <option value="0">KYC tier 0</option>
              <option value="1">KYC tier 1</option>
              <option value="2">KYC tier 2</option>
            </select>
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={blocked}
              onChange={(e) => resetTo(setBlocked, e.target.value)}
            >
              <option value="">Any status</option>
              <option value="false">Not blocked</option>
              <option value="true">Blocked</option>
            </select>
            <Button size="sm" onClick={() => navigate('/customers/new')}>
              <Plus />
              New customer
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
          <EmptyState message="No customers match this filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>KYC</TableHead>
                <TableHead>Ghana Card</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Registered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/customers/${c.id}`)}
                >
                  <TableCell className="font-medium">
                    {c.first_name} {c.last_name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.phone}</TableCell>
                  <TableCell>
                    <Badge variant="muted">Tier {c.kyc_tier}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={c.ghana_card_verified ? 'verified' : 'pending'}
                      label={c.ghana_card_verified ? 'Verified' : 'Unverified'}
                    />
                  </TableCell>
                  <TableCell>
                    {c.is_on_blocklist ? (
                      <StatusBadge status="declined" label="Blocked" />
                    ) : (
                      <StatusBadge status="active" label="Active" />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(c.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0 || isFetching}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext || isFetching}
          onClick={() => setOffset((o) => o + PAGE_SIZE)}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
