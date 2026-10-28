import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
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
import type { EmployerSector, EmployerStatus, PayrollCycle } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { useCreateEmployer, useEmployerCounts, useEmployerSummary } from '../../lib/workforce-api';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE = 50;

const FILTERS: { value: EmployerStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Not yet live' },
  { value: 'active', label: 'Live' },
  { value: 'paused', label: 'Paused' },
  { value: 'terminated', label: 'Ended' },
];

export const EMPLOYER_STATUS_WORDS: Record<EmployerStatus, string> = {
  pending: 'Not yet live',
  active: 'Live',
  paused: 'Paused',
  terminated: 'Ended',
};

export const SECTOR_WORDS: Record<EmployerSector, string> = {
  public: 'Public sector',
  private: 'Private',
  ngo: 'NGO',
  university: 'University',
};

export const CYCLE_WORDS: Record<PayrollCycle, string> = {
  weekly: 'Paid weekly',
  biweekly: 'Paid fortnightly',
  monthly: 'Paid monthly',
};

/**
 * The employers whose staff can borrow against their job.
 *
 * A link to an employer only counts toward a customer's limit while the
 * employer is live, so the counts here are the ones that matter: how many of
 * its staff we know of, how many of those have been checked, and how many have
 * signed a payroll-deduction mandate.
 */
export function EmployersListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<EmployerStatus | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);

  const counts = useEmployerCounts();
  const list = useEmployerSummary({
    ...(filter ? { status: filter } : {}),
    ...(q ? { q } : {}),
    limit: PAGE,
    offset: page * PAGE,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setQ(search.trim());
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employers"
        description="Employers whose staff can borrow against their job, and how many of them we have checked."
        actions={
          <div className="flex gap-2">
            <form onSubmit={onSearch} className="flex gap-2">
              <Input
                aria-label="Search employers"
                placeholder="Search employers"
                className="h-9 w-48"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button type="submit" variant="outline" size="sm">
                Find
              </Button>
            </form>
            <Button size="sm" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Close' : 'New employer'}
            </Button>
          </div>
        }
      />

      {adding ? <NewEmployerCard onCreated={(id) => navigate(`/employers/${id}`)} /> : null}

      <div className="flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((f) => {
          const n = counts.data ? counts.data[f.value || 'all'] : undefined;
          return (
            <Button
              key={f.value || 'all'}
              size="sm"
              role="tab"
              aria-selected={filter === f.value}
              variant={filter === f.value ? 'default' : 'outline'}
              onClick={() => {
                setFilter(f.value);
                setPage(0);
              }}
            >
              {f.label}
              {n !== undefined ? <span className="ml-1 tabular-nums opacity-70">{n}</span> : null}
            </Button>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState message="No employers match." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Staff linked</TableHead>
                  <TableHead className="text-right">Verified</TableHead>
                  <TableHead className="text-right">Payroll consent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/employers/${e.id}`)}
                  >
                    <TableCell>
                      <div className="font-medium">{e.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[e.sector ? SECTOR_WORDS[e.sector] : null, CYCLE_WORDS[e.payroll_cycle]]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.status} label={EMPLOYER_STATUS_WORDS[e.status]} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{e.active_links}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.verified_links}
                      {e.active_links > e.verified_links ? (
                        <span className="ml-1 text-xs text-warning-foreground">
                          ({e.active_links - e.verified_links} to check)
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{e.consented_links}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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
                  onClick={() => setPage((n) => n - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

function NewEmployerCard({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useCreateEmployer();
  const [form, setForm] = useState({
    name: '',
    sector: '' as EmployerSector | '',
    payroll_cycle: 'monthly' as PayrollCycle,
    contact_email: '',
    contact_phone: '',
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        name: form.name.trim(),
        payroll_cycle: form.payroll_cycle,
        ...(form.sector ? { sector: form.sector } : {}),
        ...(form.contact_email.trim() ? { contact_email: form.contact_email.trim() } : {}),
        ...(form.contact_phone.trim() ? { contact_phone: form.contact_phone.trim() } : {}),
      },
      { onSuccess: (row) => onCreated(row.id) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New employer</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-3">
              <Label htmlFor="emp-name">Name</Label>
              <Input
                id="emp-name"
                required
                maxLength={200}
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-sector">Sector</Label>
              <select
                id="emp-sector"
                className={selectClass}
                value={form.sector}
                onChange={(e) => set('sector')(e.target.value)}
              >
                <option value="">Not stated</option>
                {Object.entries(SECTOR_WORDS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-cycle">Payroll</Label>
              <select
                id="emp-cycle"
                className={selectClass}
                value={form.payroll_cycle}
                onChange={(e) => set('payroll_cycle')(e.target.value)}
              >
                {Object.entries(CYCLE_WORDS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div />
            <div className="space-y-2">
              <Label htmlFor="emp-email">HR or payroll email</Label>
              <Input
                id="emp-email"
                type="email"
                value={form.contact_email}
                onChange={(e) => set('contact_email')(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-phone">HR or payroll phone</Label>
              <Input
                id="emp-phone"
                value={form.contact_phone}
                onChange={(e) => set('contact_phone')(e.target.value)}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            A new employer starts not yet live. Links to it count toward a customer&apos;s limit
            only once it is live.
          </p>
          <Button type="submit" disabled={create.isPending || !form.name.trim()}>
            {create.isPending ? 'Adding…' : 'Add employer'}
          </Button>
          {create.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(create.error)}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
