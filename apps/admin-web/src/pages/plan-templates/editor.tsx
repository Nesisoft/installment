import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@installment/ui';
import {
  createPlanTemplateSchema,
  ghsToPesewas,
  pesewasToGhs,
  updatePlanTemplateSchema,
  type BusinessModel,
  type InstallmentFrequencyDays,
  type PlanTemplate,
} from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import {
  useCreatePlanTemplate,
  usePlanTemplate,
  useSetPlanTemplateActive,
  useUpdatePlanTemplate,
} from '../../lib/plan-templates-api';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

const MODELS: BusinessModel[] = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'];
const FREQUENCIES: InstallmentFrequencyDays[] = [7, 14, 30];

function pctToBps(s: string): number {
  return Math.round(Number(s) * 100);
}
function bpsToPctStr(bps: number): string {
  return String(bps / 100);
}
function csv(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
function localToIso(s: string): string {
  return new Date(s).toISOString();
}
function isoToLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EditorForm({ template }: { template?: PlanTemplate }) {
  const navigate = useNavigate();
  const isEdit = Boolean(template);
  const create = useCreatePlanTemplate();
  const update = useUpdatePlanTemplate(template?.id ?? '');
  const setActive = useSetPlanTemplateActive(template?.id ?? '');

  const [form, setForm] = useState({
    name: template?.name ?? '',
    description: template?.description ?? '',
    business_model: (template?.business_model ?? 'bnpl') as BusinessModel,
    number_of_installments: String(template?.number_of_installments ?? 4),
    installment_frequency_days: String(
      template?.installment_frequency_days ?? 30,
    ) as `${InstallmentFrequencyDays}`,
    down_payment_pct: template ? bpsToPctStr(template.down_payment_bps) : '0',
    interest_rate_pct: template ? bpsToPctStr(template.interest_rate_bps) : '0',
    service_fee_ghs: template ? String(pesewasToGhs(template.service_fee_flat_pesewas)) : '0',
    late_fee_ghs: template ? String(pesewasToGhs(template.late_fee_pesewas)) : '0',
    grace_period_days: String(template?.grace_period_days ?? 3),
    min_amount_ghs: template ? String(pesewasToGhs(template.min_amount_pesewas)) : '',
    max_amount_ghs: template ? String(pesewasToGhs(template.max_amount_pesewas)) : '',
    eligible_categories: template?.eligible_categories.join(', ') ?? '',
    excluded_categories: template?.excluded_categories.join(', ') ?? '',
    effective_from: isoToLocal(template?.effective_from ?? null),
    effective_to: isoToLocal(template?.effective_to ?? null),
  });
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (isEdit && template) {
      const payload = {
        name: form.name,
        description: form.description ? form.description : null,
        interest_rate_bps: pctToBps(form.interest_rate_pct),
        service_fee_flat_pesewas: ghsToPesewas(Number(form.service_fee_ghs)),
        late_fee_pesewas: ghsToPesewas(Number(form.late_fee_ghs)),
        grace_period_days: Number(form.grace_period_days),
        min_amount_pesewas: ghsToPesewas(Number(form.min_amount_ghs)),
        max_amount_pesewas: ghsToPesewas(Number(form.max_amount_ghs)),
        eligible_categories: csv(form.eligible_categories),
        excluded_categories: csv(form.excluded_categories),
        ...(form.effective_from ? { effective_from: localToIso(form.effective_from) } : {}),
        effective_to: form.effective_to ? localToIso(form.effective_to) : null,
      };
      const parsed = updatePlanTemplateSchema.safeParse(payload);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Check the form');
        return;
      }
      update.mutate(parsed.data);
      return;
    }

    const payload = {
      name: form.name,
      ...(form.description ? { description: form.description } : {}),
      business_model: form.business_model,
      number_of_installments: Number(form.number_of_installments),
      installment_frequency_days: Number(
        form.installment_frequency_days,
      ) as InstallmentFrequencyDays,
      down_payment_bps: pctToBps(form.down_payment_pct),
      interest_rate_bps: pctToBps(form.interest_rate_pct),
      service_fee_flat_pesewas: ghsToPesewas(Number(form.service_fee_ghs)),
      late_fee_pesewas: ghsToPesewas(Number(form.late_fee_ghs)),
      grace_period_days: Number(form.grace_period_days),
      min_amount_pesewas: ghsToPesewas(Number(form.min_amount_ghs)),
      max_amount_pesewas: ghsToPesewas(Number(form.max_amount_ghs)),
      eligible_categories: csv(form.eligible_categories),
      excluded_categories: csv(form.excluded_categories),
      ...(form.effective_from ? { effective_from: localToIso(form.effective_from) } : {}),
      ...(form.effective_to ? { effective_to: localToIso(form.effective_to) } : {}),
    };
    const parsed = createPlanTemplateSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    create.mutate(parsed.data, { onSuccess: (t) => navigate(`/templates/${t.id}`) });
  }

  const saving = create.isPending || update.isPending;
  const mutationError = create.error ?? update.error;

  return (
    <div className="space-y-6">
      <Link
        to="/templates"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to templates
      </Link>

      <PageHeader
        title={isEdit ? template!.name : 'New plan template'}
        description={isEdit ? 'Edit terms. Schedule shape is fixed after creation.' : undefined}
        actions={
          isEdit && template ? (
            <div className="flex items-center gap-2">
              <Badge variant={template.is_active ? 'success' : 'muted'}>
                {template.is_active ? 'Active' : 'Inactive'}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={setActive.isPending}
                onClick={() => setActive.mutate(!template.is_active)}
              >
                {template.is_active ? 'Deactivate' : 'Activate'}
              </Button>
            </div>
          ) : undefined
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="text-base">Terms</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
            </Field>
            <Field label="Description (optional)">
              <textarea
                rows={2}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Business model" hint={isEdit ? 'Fixed after creation' : undefined}>
                <select
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm disabled:opacity-60"
                  value={form.business_model}
                  disabled={isEdit}
                  onChange={(e) => set('business_model', e.target.value as BusinessModel)}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Installments" hint={isEdit ? 'Fixed after creation' : undefined}>
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={form.number_of_installments}
                  disabled={isEdit}
                  onChange={(e) => set('number_of_installments', e.target.value)}
                />
              </Field>
              <Field label="Frequency (days)" hint={isEdit ? 'Fixed after creation' : undefined}>
                <select
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm disabled:opacity-60"
                  value={form.installment_frequency_days}
                  disabled={isEdit}
                  onChange={(e) =>
                    set(
                      'installment_frequency_days',
                      e.target.value as `${InstallmentFrequencyDays}`,
                    )
                  }
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Down payment %" hint={isEdit ? 'Fixed after creation' : undefined}>
                <Input
                  type="number"
                  step="0.01"
                  value={form.down_payment_pct}
                  disabled={isEdit}
                  onChange={(e) => set('down_payment_pct', e.target.value)}
                />
              </Field>
              <Field label="Interest %">
                <Input
                  type="number"
                  step="0.01"
                  value={form.interest_rate_pct}
                  onChange={(e) => set('interest_rate_pct', e.target.value)}
                />
              </Field>
              <Field label="Grace period (days)">
                <Input
                  type="number"
                  min={0}
                  max={14}
                  value={form.grace_period_days}
                  onChange={(e) => set('grace_period_days', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Min amount (GHS)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.min_amount_ghs}
                  onChange={(e) => set('min_amount_ghs', e.target.value)}
                />
              </Field>
              <Field label="Max amount (GHS)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.max_amount_ghs}
                  onChange={(e) => set('max_amount_ghs', e.target.value)}
                />
              </Field>
              <Field label="Service fee (GHS)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.service_fee_ghs}
                  onChange={(e) => set('service_fee_ghs', e.target.value)}
                />
              </Field>
              <Field label="Late fee (GHS)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.late_fee_ghs}
                  onChange={(e) => set('late_fee_ghs', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Eligible categories" hint="Comma-separated, blank = all">
                <Input
                  value={form.eligible_categories}
                  onChange={(e) => set('eligible_categories', e.target.value)}
                />
              </Field>
              <Field label="Excluded categories" hint="Comma-separated">
                <Input
                  value={form.excluded_categories}
                  onChange={(e) => set('excluded_categories', e.target.value)}
                />
              </Field>
              <Field label="Effective from (optional)">
                <Input
                  type="datetime-local"
                  value={form.effective_from}
                  onChange={(e) => set('effective_from', e.target.value)}
                />
              </Field>
              <Field label="Effective to (optional)">
                <Input
                  type="datetime-local"
                  value={form.effective_to}
                  onChange={(e) => set('effective_to', e.target.value)}
                />
              </Field>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {mutationError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(mutationError)}</p>
            ) : null}
            {update.isSuccess ? <p className="text-sm text-success">Saved.</p> : null}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate('/templates')}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlanTemplateEditorPage() {
  const { id } = useParams();
  const query = usePlanTemplate(id ?? '');

  if (!id) return <EditorForm />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <EditorForm template={query.data} />;
}
