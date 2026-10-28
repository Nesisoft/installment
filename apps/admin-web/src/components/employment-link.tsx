import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input, Label, StatusBadge } from '@installment/ui';
import {
  EMPLOYMENT_VERIFICATION_METHODS,
  type EmploymentEvent,
  type EmploymentRow,
  type EmploymentStatus,
  type EmploymentVerificationMethod,
} from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { useEmploymentActions } from '../lib/workforce-api';
import { formatDate, waitingFor } from '../lib/format';

export const METHOD_LABEL: Record<EmploymentVerificationMethod, string> = {
  employer_confirmed: 'The employer confirmed it (HR or payroll office)',
  employer_list: 'On a staff list or payroll file the employer sent',
  payslip: 'A recent payslip from this employer, in their name',
};

const STATUS_WORDS: Record<EmploymentStatus, string> = {
  active: 'Works there',
  on_leave: 'On leave',
  suspended: 'Link suspended',
  left_employer: 'Left',
};

const EVENTS: Record<EmploymentStatus, { event: EmploymentEvent; label: string }[]> = {
  active: [
    { event: 'leave_employer', label: 'Has left the job' },
    { event: 'take_leave', label: 'Is on leave' },
    { event: 'suspend', label: 'Suspend the link' },
  ],
  on_leave: [{ event: 'return_from_leave', label: 'Is back from leave' }],
  suspended: [{ event: 'reinstate', label: 'Reinstate the link' }],
  left_employer: [{ event: 'rejoin', label: 'Has rejoined' }],
};

const BAND_WORDS: Record<string, string> = {
  unknown: 'Salary not known',
  low: 'Low salary band',
  mid: 'Middle salary band',
  high: 'High salary band',
};

type Mode = null | 'verify' | 'unverify' | 'consent' | 'withdraw-consent' | EmploymentEvent;

/**
 * One customer's job at one employer, and everything staff can do to it.
 *
 * Verifying it is what lifts a first-time customer above the base starter
 * limit, and payroll consent lifts it further, so both ask for what was
 * checked rather than being a single button. `show` picks which side of the
 * link to name: the employer on a customer's page, the customer elsewhere.
 */
export function EmploymentLinkRow({
  link,
  show,
}: {
  link: EmploymentRow;
  show: 'customer' | 'employer' | 'both';
}) {
  const actions = useEmploymentActions(link.id);
  const [mode, setMode] = useState<Mode>(null);
  const [method, setMethod] = useState<EmploymentVerificationMethod | ''>('');
  const [text, setText] = useState('');
  const verified = link.verified_at !== null;
  const holdsJob = link.status === 'active';
  const employerEnded = link.employer_status === 'terminated';
  const pending =
    actions.verify.isPending ||
    actions.unverify.isPending ||
    actions.consent.isPending ||
    actions.transition.isPending;
  const error =
    actions.verify.error ??
    actions.unverify.error ??
    actions.consent.error ??
    actions.transition.error;

  function open(next: Mode) {
    setMode(next);
    setMethod('');
    setText('');
    for (const m of Object.values(actions)) m.reset();
  }
  const done = { onSuccess: () => open(null) };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const note = text.trim();
    if (mode === 'verify') {
      if (!method || note.length < 3) return;
      actions.verify.mutate({ method, note }, done);
    } else if (mode === 'unverify') {
      if (note.length < 3) return;
      actions.unverify.mutate({ reason: note }, done);
    } else if (mode === 'consent') {
      if (note.length < 3) return;
      actions.consent.mutate({ granted: true, note }, done);
    } else if (mode === 'withdraw-consent') {
      actions.consent.mutate({ granted: false, ...(note.length >= 3 ? { note } : {}) }, done);
    } else if (mode) {
      actions.transition.mutate({ event: mode, ...(note ? { reason: note } : {}) }, done);
    }
  }

  const transition = mode && EVENTS[link.status].find((e) => e.event === mode);

  return (
    <div className="space-y-3 py-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-48 flex-1">
          {show !== 'employer' ? (
            <div className="font-medium">
              <Link to={`/customers/${link.customer_id}`} className="text-primary hover:underline">
                {link.customer_name ?? 'Unnamed customer'}
              </Link>
              {link.customer_phone ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {link.customer_phone}
                </span>
              ) : null}
            </div>
          ) : null}
          {show !== 'customer' ? (
            <div className={show === 'both' ? 'text-sm' : 'font-medium'}>
              <Link to={`/employers/${link.employer_id}`} className="text-primary hover:underline">
                {link.employer_name}
              </Link>
              {link.employer_status !== 'active' ? (
                <span className="ml-2 text-xs text-warning-foreground">
                  employer {link.employer_status}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            {[
              link.employee_number ? `Staff no. ${link.employee_number}` : 'No staff number',
              BAND_WORDS[link.salary_band] ?? link.salary_band,
              link.employment_start_date ? `since ${formatDate(link.employment_start_date)}` : null,
              `linked ${formatDate(link.created_at)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={link.status} label={STATUS_WORDS[link.status]} />
          {verified ? (
            <StatusBadge status="verified" label={`Verified ${formatDate(link.verified_at)}`} />
          ) : (
            <StatusBadge
              status="pending"
              tone="warning"
              label={
                holdsJob ? `Not verified · waiting ${waitingFor(link.created_at)}` : 'Not verified'
              }
            />
          )}
          {link.payroll_deduction_consent ? (
            <StatusBadge status="active" label="Payroll consent" />
          ) : null}
        </div>
      </div>

      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          {holdsJob && !verified && !employerEnded ? (
            <Button size="sm" onClick={() => open('verify')}>
              Verify the job…
            </Button>
          ) : null}
          {verified ? (
            <Button size="sm" variant="outline" onClick={() => open('unverify')}>
              Withdraw verification…
            </Button>
          ) : null}
          {holdsJob && !link.payroll_deduction_consent ? (
            <Button size="sm" variant="outline" onClick={() => open('consent')}>
              Record payroll consent…
            </Button>
          ) : null}
          {link.payroll_deduction_consent ? (
            <Button size="sm" variant="outline" onClick={() => open('withdraw-consent')}>
              Withdraw payroll consent…
            </Button>
          ) : null}
          {EVENTS[link.status].map((e) => (
            <Button key={e.event} size="sm" variant="ghost" onClick={() => open(e.event)}>
              {e.label}…
            </Button>
          ))}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-4">
          {mode === 'verify' ? (
            <>
              <p className="text-sm">
                Verifying lets a first-time customer borrow more on their first order while the
                employer is active. Say how you know.
              </p>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">How was the job confirmed?</legend>
                {EMPLOYMENT_VERIFICATION_METHODS.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`method-${link.id}`}
                      value={m}
                      checked={method === m}
                      onChange={() => setMethod(m)}
                    />
                    {METHOD_LABEL[m]}
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          {mode === 'unverify' ? (
            <p className="text-sm">
              The customer goes back to the base limit for a first order on their next decision.
            </p>
          ) : null}
          {mode === 'consent' ? (
            <p className="text-sm">
              Only with a signed payroll-deduction mandate. It doubles a scored customer&apos;s
              limit, and with the job verified it raises what a first-time customer may borrow.
            </p>
          ) : null}
          {transition ? (
            <p className="text-sm">
              {mode === 'leave_employer'
                ? 'Leaving clears the verification and any payroll consent: if they rejoin, both are recorded again.'
                : `Mark this link: ${transition.label.toLowerCase()}.`}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={`note-${link.id}`}>
              {mode === 'verify'
                ? 'What you checked, and with whom'
                : mode === 'consent'
                  ? 'Where the signed mandate is'
                  : mode === 'unverify'
                    ? 'Why it is being withdrawn'
                    : 'Note (optional)'}
            </Label>
            <Input
              id={`note-${link.id}`}
              maxLength={500}
              placeholder={
                mode === 'verify'
                  ? 'e.g. Ama Boateng, GES HR, by phone, 14 Oct'
                  : mode === 'consent'
                    ? 'e.g. Signed form filed as PDM-0042'
                    : ''
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant={
                mode === 'unverify' || mode === 'withdraw-consent' || mode === 'leave_employer'
                  ? 'destructive'
                  : 'default'
              }
              disabled={
                pending ||
                (mode === 'verify' && (!method || text.trim().length < 3)) ||
                ((mode === 'unverify' || mode === 'consent') && text.trim().length < 3)
              }
            >
              {pending
                ? 'Saving…'
                : mode === 'verify'
                  ? 'Mark verified'
                  : mode === 'unverify'
                    ? 'Withdraw verification'
                    : mode === 'consent'
                      ? 'Record consent'
                      : mode === 'withdraw-consent'
                        ? 'Withdraw consent'
                        : (transition?.label ?? 'Save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => open(null)}>
              Cancel
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{apiErrorMessage(error)}</p> : null}
        </form>
      )}
    </div>
  );
}
