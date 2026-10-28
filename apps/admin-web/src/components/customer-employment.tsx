import { useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@installment/ui';
import type { SalaryBand } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { useEmployerSummary, useEmployment, useLinkEmployment } from '../lib/workforce-api';
import { EmploymentLinkRow } from './employment-link';
import { ErrorState, LoadingState } from './data-states';

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

/**
 * Where the customer works, and whether anyone has checked.
 *
 * The scorer reads the customer's most recent link to a live employer, so the
 * newest link is the one that counts; older ones are kept as history.
 */
export function CustomerEmploymentCard({ customerId }: { customerId: string }) {
  const links = useEmployment({ customer_id: customerId, limit: 50 }, Boolean(customerId));
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Employment</CardTitle>
          <CardDescription>
            A verified job at a live employer raises what this customer may borrow on a first order;
            payroll consent raises it further. Only their newest link to a live employer counts.
          </CardDescription>
        </div>
        {!adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Link an employer
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding ? (
          <LinkEmployerForm customerId={customerId} onDone={() => setAdding(false)} />
        ) : null}
        {links.isPending ? (
          <LoadingState />
        ) : links.isError ? (
          <ErrorState error={links.error} onRetry={() => void links.refetch()} />
        ) : links.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employer linked.</p>
        ) : (
          <div className="divide-y divide-border">
            {links.data.rows.map((l) => (
              <EmploymentLinkRow key={l.id} link={l} show="employer" />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LinkEmployerForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const employers = useEmployerSummary({ limit: 200 });
  const link = useLinkEmployment();
  const [form, setForm] = useState({
    employer_id: '',
    employee_number: '',
    salary_band: 'unknown' as SalaryBand,
    employment_start_date: '',
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const options = (employers.data?.rows ?? []).filter((e) => e.status !== 'terminated');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.employer_id) return;
    link.mutate(
      {
        customer_id: customerId,
        employer_id: form.employer_id,
        salary_band: form.salary_band,
        ...(form.employee_number.trim() ? { employee_number: form.employee_number.trim() } : {}),
        ...(form.employment_start_date
          ? { employment_start_date: form.employment_start_date }
          : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="link-employer">Employer</Label>
          <select
            id="link-employer"
            required
            className={selectClass}
            value={form.employer_id}
            onChange={(e) => set('employer_id')(e.target.value)}
          >
            <option value="">Choose…</option>
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.status !== 'active'
                  ? ` (${e.status === 'pending' ? 'not yet live' : e.status})`
                  : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-staff-no">Staff number</Label>
          <Input
            id="link-staff-no"
            maxLength={50}
            value={form.employee_number}
            onChange={(e) => set('employee_number')(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-band">Salary band</Label>
          <select
            id="link-band"
            className={selectClass}
            value={form.salary_band}
            onChange={(e) => set('salary_band')(e.target.value)}
          >
            <option value="unknown">Not known</option>
            <option value="low">Low</option>
            <option value="mid">Middle</option>
            <option value="high">High</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-start">Started there</Label>
          <Input
            id="link-start"
            type="date"
            value={form.employment_start_date}
            onChange={(e) => set('employment_start_date')(e.target.value)}
          />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        A link is only what the customer told us. It adds to their score, but it does not raise a
        first-time customer&apos;s limit until someone verifies it.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={link.isPending || !form.employer_id}>
          {link.isPending ? 'Linking…' : 'Link'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {link.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(link.error)}</p>
      ) : null}
    </form>
  );
}
