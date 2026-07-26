import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import {
  formatGhs,
  ghsToPesewas,
  recordDecisionSchema,
  type DecisionOutcome,
  type ScoringDecision,
} from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft, FlaskConical, Play, Rocket } from 'lucide-react';
import {
  useApplication,
  useDryRun,
  useLatestDecision,
  useRecordDecision,
  useScoreApplication,
} from '../../lib/admin-api';
import { useActivateFromApplication } from '../../lib/plans-api';
import { formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';
import { RuleBreakdown } from '../../components/rule-breakdown';

const ACTIONABLE = new Set(['pending', 'manual_review', 'counter_offered']);

const OUTCOMES: { value: DecisionOutcome; label: string }[] = [
  { value: 'approved', label: 'Approve' },
  { value: 'approved_tier_2', label: 'Approve (tier 2)' },
  { value: 'counter_offer', label: 'Counter-offer' },
  { value: 'manual_review', label: 'Refer to manual review' },
  { value: 'declined', label: 'Decline' },
];

function ghs(value: number): string {
  return `₵${value.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

function DecisionPreview({ decision }: { decision: ScoringDecision }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <StatusBadge status={decision.outcome} />
        <span className="text-sm text-muted-foreground">
          Score <span className="font-semibold text-foreground">{decision.score}</span> / 1000 ·{' '}
          {decision.riskBand} · limit {ghs(decision.approvedLimitGhs)} · ruleset{' '}
          {decision.rulesetVersion}
        </span>
      </div>
      {decision.counterOffer ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Counter-offer: down {ghs(decision.counterOffer.downPaymentGhs)}, financed{' '}
          {ghs(decision.counterOffer.revisedAmountGhs)} over{' '}
          {decision.counterOffer.revisedTermMonths} months
        </p>
      ) : null}
      <RuleBreakdown rules={decision.rulesFired} />
    </div>
  );
}

export function ApplicationDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const application = useApplication(id);
  const decision = useLatestDecision(id);
  const dryRun = useDryRun(id);
  const score = useScoreApplication(id);
  const recordDecision = useRecordDecision(id);
  const activate = useActivateFromApplication();

  const [outcome, setOutcome] = useState<DecisionOutcome>('approved');
  const [declinedReason, setDeclinedReason] = useState('');
  const [counterDown, setCounterDown] = useState('');
  const [counterFinanced, setCounterFinanced] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (application.isPending) return <LoadingState />;
  if (application.isError)
    return <ErrorState error={application.error} onRetry={() => void application.refetch()} />;

  const app = application.data;
  const actionable = ACTIONABLE.has(app.status);

  function onSubmitDecision(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = {
      outcome,
      ...(outcome === 'declined' && declinedReason ? { declined_reason: declinedReason } : {}),
      ...(outcome === 'counter_offer'
        ? {
            counter_down_payment_pesewas: ghsToPesewas(Number(counterDown)),
            counter_financed_pesewas: ghsToPesewas(Number(counterFinanced)),
          }
        : {}),
    };
    const parsed = recordDecisionSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the decision details');
      return;
    }
    recordDecision.mutate(parsed.data, {
      onSuccess: () => {
        setDeclinedReason('');
        setCounterDown('');
        setCounterFinanced('');
      },
    });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/applications"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to queue
      </Link>

      <PageHeader
        title={app.order_reference}
        description={`${formatGhs(app.order_amount_pesewas)} · ${app.merchant_category}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={app.status} />
            {app.status === 'approved' ? (
              <Button
                size="sm"
                disabled={activate.isPending}
                onClick={() =>
                  activate.mutate(app.id, {
                    onSuccess: (res) => navigate(`/plans/${res.plan.id}`),
                  })
                }
              >
                <Rocket />
                {activate.isPending ? 'Activating…' : 'Activate to plan'}
              </Button>
            ) : null}
          </div>
        }
      />

      {activate.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(activate.error)}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Application</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Order amount" value={formatGhs(app.order_amount_pesewas)} />
            <Field label="Category" value={app.merchant_category} />
            <Field label="Submitted" value={formatDateTime(app.created_at)} />
            <Field label="Expires" value={formatDateTime(app.expires_at)} />
            <Field label="Customer" value={app.customer_id} />
            <Field label="Merchant" value={app.merchant_id} />
            <Field label="Plan template" value={app.plan_template_id} />
            {app.decision_at ? (
              <Field label="Decided" value={formatDateTime(app.decision_at)} />
            ) : null}
            {app.declined_reason ? (
              <Field label="Declined reason" value={app.declined_reason} />
            ) : null}
            {app.counter_down_payment_pesewas != null ? (
              <Field
                label="Counter down-payment"
                value={formatGhs(app.counter_down_payment_pesewas)}
              />
            ) : null}
            {app.counter_financed_pesewas != null ? (
              <Field label="Counter financed" value={formatGhs(app.counter_financed_pesewas)} />
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Credit scoring</CardTitle>
            <CardDescription>
              Dry-run previews against live signals without saving. Score &amp; persist records the
              decision and transitions the application.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => dryRun.mutate()}
              disabled={dryRun.isPending}
            >
              <FlaskConical />
              {dryRun.isPending ? 'Scoring…' : 'Dry-run'}
            </Button>
            <Button size="sm" onClick={() => score.mutate()} disabled={score.isPending}>
              <Play />
              {score.isPending ? 'Scoring…' : 'Score & persist'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {dryRun.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(dryRun.error)}</p>
          ) : null}
          {score.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(score.error)}</p>
          ) : null}

          {dryRun.data ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Preview (not saved)</p>
              <DecisionPreview decision={dryRun.data} />
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">Latest recorded decision</p>
            {decision.isPending ? (
              <LoadingState label="Loading decision…" />
            ) : decision.isError ? (
              <ErrorState error={decision.error} onRetry={() => void decision.refetch()} />
            ) : decision.data ? (
              <div className="rounded-md border border-border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <StatusBadge status={decision.data.outcome} />
                  <span className="text-sm text-muted-foreground">
                    Score{' '}
                    <span className="font-semibold text-foreground">{decision.data.score}</span> /
                    1000 · {decision.data.risk_band} · limit{' '}
                    {decision.data.approved_limit_pesewas != null
                      ? formatGhs(decision.data.approved_limit_pesewas)
                      : '—'}{' '}
                    · ruleset {decision.data.ruleset_version} ·{' '}
                    {formatDateTime(decision.data.decided_at)}
                  </span>
                </div>
                <RuleBreakdown rules={decision.data.rules_fired} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not scored yet. Run the engine or record a manual decision below.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Record decision</CardTitle>
          <CardDescription>
            {actionable
              ? 'Apply a human-override outcome to this application.'
              : `This application is ${app.status.replace(/_/g, ' ')} and cannot take a new decision.`}
          </CardDescription>
        </CardHeader>
        {actionable ? (
          <CardContent>
            <form onSubmit={onSubmitDecision} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="outcome">Outcome</Label>
                <select
                  id="outcome"
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value as DecisionOutcome)}
                >
                  {OUTCOMES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {outcome === 'declined' ? (
                <div className="space-y-2">
                  <Label htmlFor="reason">Decline reason</Label>
                  <textarea
                    id="reason"
                    rows={3}
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={declinedReason}
                    onChange={(e) => setDeclinedReason(e.target.value)}
                    placeholder="Why is this application being declined?"
                  />
                </div>
              ) : null}

              {outcome === 'counter_offer' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="down">Counter down-payment (GHS)</Label>
                    <Input
                      id="down"
                      type="number"
                      min={0}
                      step="0.01"
                      value={counterDown}
                      onChange={(e) => setCounterDown(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="financed">Counter financed (GHS)</Label>
                    <Input
                      id="financed"
                      type="number"
                      min={0}
                      step="0.01"
                      value={counterFinanced}
                      onChange={(e) => setCounterFinanced(e.target.value)}
                    />
                  </div>
                </div>
              ) : null}

              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
              {recordDecision.isError ? (
                <p className="text-sm text-destructive">{apiErrorMessage(recordDecision.error)}</p>
              ) : null}
              {recordDecision.isSuccess ? (
                <p className="text-sm text-success">Decision recorded.</p>
              ) : null}

              <Button type="submit" disabled={recordDecision.isPending}>
                {recordDecision.isPending ? 'Recording…' : 'Record decision'}
              </Button>
            </form>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
