import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
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
import {
  closeCaseSchema,
  formatGhs,
  recordActionSchema,
  type RecordActionInput,
} from '@installment/api-types';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import { ArrowLeft, UserCheck } from 'lucide-react';
import {
  useAssignCase,
  useCloseCase,
  useCollectionsCase,
  useRecordCaseAction,
} from '../../lib/collections-api';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

const ACTION_TYPES: RecordActionInput['action_type'][] = [
  'call_made',
  'sms_sent',
  'email_sent',
  'visit_scheduled',
  'visit_completed',
  'note_added',
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

export function CollectionsDetailPage() {
  const { id = '' } = useParams();
  const { session } = useAuth();
  const detail = useCollectionsCase(id);
  const assign = useAssignCase(id);
  const recordAction = useRecordCaseAction(id);
  const closeCase = useCloseCase(id);

  const [action, setAction] = useState<{
    action_type: RecordActionInput['action_type'];
    outcome: string;
    notes: string;
  }>({ action_type: 'call_made', outcome: '', notes: '' });
  const [agentId, setAgentId] = useState('');
  const [close, setClose] = useState<{ resolution: string; notes: string }>({
    resolution: 'paid',
    notes: '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  if (detail.isPending) return <LoadingState />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;

  const { case: c, actions, plan, schedule, customer } = detail.data;
  const isOpen = c.closed_at === null;

  function onRecordAction(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      action_type: action.action_type,
      ...(action.outcome ? { outcome: action.outcome } : {}),
      ...(action.notes ? { notes: action.notes } : {}),
    };
    const parsed = recordActionSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the action');
      return;
    }
    recordAction.mutate(parsed.data, {
      onSuccess: () => setAction({ action_type: 'call_made', outcome: '', notes: '' }),
    });
  }

  function onClose(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = closeCaseSchema.safeParse({
      resolution: close.resolution,
      ...(close.notes ? { notes: close.notes } : {}),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the resolution');
      return;
    }
    closeCase.mutate(parsed.data);
  }

  return (
    <div className="space-y-6">
      <Link
        to="/collections"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to cases
      </Link>

      <PageHeader
        title="Collections case"
        description={
          customer ? `${customer.first_name} ${customer.last_name} · ${customer.phone}` : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={c.current_stage} />
            {c.resolution ? <StatusBadge status={c.resolution} /> : null}
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Context</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Stage" value={c.current_stage.replace(/_/g, ' ')} />
            <Field label="Opened" value={formatDate(c.opened_at)} />
            <Field label="Stage since" value={formatDate(c.stage_entered_at)} />
            <Field label="Assigned agent" value={c.assigned_agent_id ?? '—'} />
            <Field label="Recovered" value={formatGhs(c.amount_recovered_pesewas)} />
            {plan ? (
              <Field label="Plan outstanding" value={formatGhs(plan.outstanding_pesewas)} />
            ) : null}
            {schedule ? (
              <Field
                label="Installment"
                value={`#${schedule.sequence_number} · ${formatGhs(schedule.amount_due_pesewas)} · due ${formatDate(schedule.due_date)}`}
              />
            ) : null}
            {schedule ? <Field label="Installment status" value={schedule.status} /> : null}
            <Field label="Plan" value={c.customer_plan_id} />
          </dl>
        </CardContent>
      </Card>

      {isOpen ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Assign</CardTitle>
              <CardDescription>Take ownership or assign to another agent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={() => session && assign.mutate({ agent_id: session.userId })}
                disabled={assign.isPending || !session}
              >
                <UserCheck />
                Assign to me
              </Button>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-2">
                  <Label>Agent ID</Label>
                  <Input
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder="UUID of an agent user"
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={assign.isPending || !agentId}
                  onClick={() => assign.mutate({ agent_id: agentId })}
                >
                  Assign
                </Button>
              </div>
              {assign.isError ? (
                <p className="text-sm text-destructive">{apiErrorMessage(assign.error)}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Record action</CardTitle>
              <CardDescription>Log a contact attempt or note.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onRecordAction} className="space-y-3">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                    value={action.action_type}
                    onChange={(e) =>
                      setAction((a) => ({
                        ...a,
                        action_type: e.target.value as RecordActionInput['action_type'],
                      }))
                    }
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Outcome (optional)</Label>
                  <Input
                    value={action.outcome}
                    onChange={(e) => setAction((a) => ({ ...a, outcome: e.target.value }))}
                    placeholder="e.g. no answer, promised to pay"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes (optional)</Label>
                  <textarea
                    rows={2}
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={action.notes}
                    onChange={(e) => setAction((a) => ({ ...a, notes: e.target.value }))}
                  />
                </div>
                <Button type="submit" disabled={recordAction.isPending}>
                  {recordAction.isPending ? 'Saving…' : 'Log action'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {isOpen ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Close case</CardTitle>
            <CardDescription>
              Manual resolutions only. Default / write-off happen via the dunning sweep.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onClose} className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label>Resolution</Label>
                <select
                  className="h-10 rounded-md border border-input bg-card px-3 text-sm"
                  value={close.resolution}
                  onChange={(e) => setClose((s) => ({ ...s, resolution: e.target.value }))}
                >
                  <option value="paid">Paid</option>
                  <option value="waived">Waived</option>
                  <option value="restructured">Restructured</option>
                </select>
              </div>
              <div className="flex-1 space-y-2">
                <Label>Notes (optional)</Label>
                <Input
                  value={close.notes}
                  onChange={(e) => setClose((s) => ({ ...s, notes: e.target.value }))}
                />
              </div>
              <Button type="submit" variant="destructive" disabled={closeCase.isPending}>
                {closeCase.isPending ? 'Closing…' : 'Close case'}
              </Button>
            </form>
            {closeCase.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(closeCase.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions recorded yet.</p>
          ) : (
            <ol className="space-y-3">
              {actions.map((a) => (
                <li key={a.id} className="flex gap-3 border-b border-border pb-3 last:border-0">
                  <Badge variant="muted" className="h-fit shrink-0">
                    {a.action_type.replace(/_/g, ' ')}
                  </Badge>
                  <div className="min-w-0 text-sm">
                    <p className="text-foreground">
                      {a.outcome ?? '—'}
                      {a.notes ? <span className="text-muted-foreground"> · {a.notes}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(a.performed_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
