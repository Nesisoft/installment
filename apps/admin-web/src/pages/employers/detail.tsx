import { useState, type FormEvent, type ReactNode } from 'react';
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
} from '@installment/ui';
import type {
  Employer,
  EmployerEvent,
  EmployerSector,
  EmployerStatus,
  EmploymentStatus,
  PayrollCycle,
} from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import {
  useEmployer,
  useEmployment,
  useTransitionEmployer,
  useUpdateEmployer,
} from '../../lib/workforce-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';
import { EmploymentLinkRow } from '../../components/employment-link';
import { CYCLE_WORDS, EMPLOYER_STATUS_WORDS, SECTOR_WORDS } from './list';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

const EVENTS: Record<EmployerStatus, { event: EmployerEvent; label: string; danger?: boolean }[]> =
  {
    pending: [{ event: 'activate', label: 'Make it live' }],
    active: [
      { event: 'pause', label: 'Pause' },
      { event: 'terminate', label: 'End the partnership', danger: true },
    ],
    paused: [
      { event: 'resume', label: 'Resume' },
      { event: 'terminate', label: 'End the partnership', danger: true },
    ],
    terminated: [],
  };

const EVENT_EFFECT: Record<EmployerEvent, string> = {
  activate:
    'Links to this employer start counting toward its staff’s limits, verified ones most of all.',
  pause:
    'Links stop counting toward limits until it is resumed. Plans already running are not touched.',
  resume: 'Links count toward limits again.',
  terminate:
    'Final. Links stop counting for good, no new links can be made, and no link to it can be verified.',
};

const LINK_FILTERS: { value: EmploymentStatus | 'unverified' | ''; label: string }[] = [
  { value: 'unverified', label: 'To check' },
  { value: 'active', label: 'Works there' },
  { value: '', label: 'All' },
];

export function EmployerDetailPage() {
  const { id = '' } = useParams();
  const employer = useEmployer(id);
  const [editing, setEditing] = useState(false);
  const [linkFilter, setLinkFilter] = useState<EmploymentStatus | 'unverified' | ''>('unverified');
  const links = useEmployment(
    {
      employer_id: id,
      ...(linkFilter === 'unverified'
        ? { status: 'active', verified: false }
        : linkFilter
          ? { status: linkFilter }
          : {}),
      limit: 200,
    },
    Boolean(id),
  );

  if (employer.isPending) return <LoadingState />;
  if (employer.isError) {
    return <ErrorState error={employer.error} onRetry={() => void employer.refetch()} />;
  }
  const e = employer.data;

  return (
    <div className="space-y-6">
      <Link
        to="/employers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Employers
      </Link>

      <PageHeader
        title={e.name}
        description={[e.sector ? SECTOR_WORDS[e.sector] : null, CYCLE_WORDS[e.payroll_cycle]]
          .filter(Boolean)
          .join(' · ')}
        actions={<StatusBadge status={e.status} label={EMPLOYER_STATUS_WORDS[e.status]} />}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Partnership</CardTitle>
          {!editing ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {editing ? (
            <EditEmployerForm employer={e} onDone={() => setEditing(false)} />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Partnership since" value={formatDate(e.partnership_start_date)} />
              <Field label="HR or payroll email" value={e.contact_email ?? '—'} />
              <Field label="HR or payroll phone" value={e.contact_phone ?? '—'} />
              <Field label="Added" value={formatDate(e.created_at)} />
            </dl>
          )}
          <EmployerTransitions employer={e} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staff we know of</CardTitle>
          <CardDescription>
            Customers linked to this employer. Link a customer from their own page.
          </CardDescription>
          <div className="flex flex-wrap gap-2 pt-2" role="tablist">
            {LINK_FILTERS.map((f) => (
              <Button
                key={f.value || 'all'}
                size="sm"
                role="tab"
                aria-selected={linkFilter === f.value}
                variant={linkFilter === f.value ? 'default' : 'outline'}
                onClick={() => setLinkFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {links.isPending ? (
            <LoadingState />
          ) : links.isError ? (
            <ErrorState error={links.error} onRetry={() => void links.refetch()} />
          ) : links.data.rows.length === 0 ? (
            <EmptyState
              message={
                linkFilter === 'unverified' ? 'Nobody here is waiting to be checked.' : 'No links.'
              }
            />
          ) : (
            <div className="divide-y divide-border">
              {links.data.rows.map((l) => (
                <EmploymentLinkRow key={l.id} link={l} show="customer" />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmployerTransitions({ employer }: { employer: Employer }) {
  const transition = useTransitionEmployer(employer.id);
  const [chosen, setChosen] = useState<EmployerEvent | null>(null);
  const [reason, setReason] = useState('');
  const events = EVENTS[employer.status];
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The partnership has ended. Links to this employer no longer count.
      </p>
    );
  }
  const danger = chosen === 'terminate' || chosen === 'pause';

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (!chosen) return;
    if (danger && reason.trim().length < 3) return;
    transition.mutate(
      { event: chosen, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          setChosen(null);
          setReason('');
        },
      },
    );
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      {chosen === null ? (
        <div className="flex flex-wrap gap-2">
          {events.map((ev) => (
            <Button
              key={ev.event}
              size="sm"
              variant={ev.danger ? 'outline' : 'default'}
              onClick={() => setChosen(ev.event)}
            >
              {ev.label}…
            </Button>
          ))}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <p className="text-sm">{EVENT_EFFECT[chosen]}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Reason"
              className="h-9 min-w-72 flex-1"
              maxLength={500}
              placeholder={danger ? 'Reason (required)' : 'Reason (optional)'}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant={chosen === 'terminate' ? 'destructive' : 'default'}
              disabled={transition.isPending || (danger && reason.trim().length < 3)}
            >
              {transition.isPending ? 'Saving…' : events.find((x) => x.event === chosen)?.label}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setChosen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {transition.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(transition.error)}</p>
      ) : null}
    </div>
  );
}

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

function EditEmployerForm({ employer, onDone }: { employer: Employer; onDone: () => void }) {
  const update = useUpdateEmployer(employer.id);
  const [form, setForm] = useState({
    name: employer.name,
    sector: (employer.sector ?? '') as EmployerSector | '',
    payroll_cycle: employer.payroll_cycle,
    contact_email: employer.contact_email ?? '',
    contact_phone: employer.contact_phone ?? '',
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    update.mutate(
      {
        name: form.name.trim(),
        payroll_cycle: form.payroll_cycle as PayrollCycle,
        ...(form.sector ? { sector: form.sector } : {}),
        ...(form.contact_email.trim() ? { contact_email: form.contact_email.trim() } : {}),
        ...(form.contact_phone.trim() ? { contact_phone: form.contact_phone.trim() } : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-3">
          <Label htmlFor="edit-emp-name">Name</Label>
          <Input
            id="edit-emp-name"
            required
            maxLength={200}
            value={form.name}
            onChange={(ev) => set('name')(ev.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-emp-sector">Sector</Label>
          <select
            id="edit-emp-sector"
            className={selectClass}
            value={form.sector}
            onChange={(ev) => set('sector')(ev.target.value)}
          >
            <option value="" disabled={Boolean(employer.sector)}>
              Not stated
            </option>
            {Object.entries(SECTOR_WORDS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-emp-cycle">Payroll</Label>
          <select
            id="edit-emp-cycle"
            className={selectClass}
            value={form.payroll_cycle}
            onChange={(ev) => set('payroll_cycle')(ev.target.value)}
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
          <Label htmlFor="edit-emp-email">HR or payroll email</Label>
          <Input
            id="edit-emp-email"
            type="email"
            value={form.contact_email}
            onChange={(ev) => set('contact_email')(ev.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-emp-phone">HR or payroll phone</Label>
          <Input
            id="edit-emp-phone"
            value={form.contact_phone}
            onChange={(ev) => set('contact_phone')(ev.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending || !form.name.trim()}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {update.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(update.error)}</p>
      ) : null}
    </form>
  );
}
