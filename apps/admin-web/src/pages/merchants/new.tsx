import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, CardContent, Input, Label } from '@installment/ui';
import { createMerchantSchema, formatBps, type BusinessModel } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import { useCreateMerchant } from '../../lib/merchants-api';
import { parseBpsOverride } from '../../lib/terms';
import { PageHeader } from '../../components/page-header';

const MODELS: BusinessModel[] = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'];

/** " (2.50%)" beside a field holding a valid rate; nothing beside a blank or bad one. */
function previewBps(input: string): string {
  const parsed = parseBpsOverride(input, 5000);
  return parsed.ok && parsed.value !== null ? ` (${formatBps(parsed.value)})` : '';
}

export function MerchantNewPage() {
  const navigate = useNavigate();
  const create = useCreateMerchant();
  const [form, setForm] = useState({
    business_name: '',
    legal_name: '',
    email: '',
    phone: '',
    tin: '',
    registration_number: '',
    default_business_model: 'bnpl' as BusinessModel,
    // Blank means no deal: each plan charges its business model's own rate.
    mdr_bps_override: '',
    reserve_bps_override: '',
    commission_bps_override: '',
  });
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // These were "MDR bps" / "Reserve bps" writing `default_mdr_bps` and
    // `default_reserve_bps`, which nothing has charged since migration 0009:
    // whatever was typed, the merchant paid the model rate.
    const mdr = parseBpsOverride(form.mdr_bps_override, 2000);
    if (!mdr.ok) return setError(`MDR: ${mdr.message}`);
    const reserve = parseBpsOverride(form.reserve_bps_override, 5000);
    if (!reserve.ok) return setError(`Reserve: ${reserve.message}`);
    const commission = parseBpsOverride(form.commission_bps_override, 2000);
    if (!commission.ok) return setError(`Commission: ${commission.message}`);
    const payload = {
      business_name: form.business_name,
      legal_name: form.legal_name,
      email: form.email,
      phone: form.phone,
      ...(form.tin ? { tin: form.tin } : {}),
      ...(form.registration_number ? { registration_number: form.registration_number } : {}),
      default_business_model: form.default_business_model,
      mdr_bps_override: mdr.value,
      reserve_bps_override: reserve.value,
      commission_bps_override: commission.value,
    };
    const parsed = createMerchantSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (m) => navigate(`/merchants/${m.id}`),
    });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/merchants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to merchants
      </Link>
      <PageHeader title="New merchant" description="Onboard a retail partner." />

      <Card className="max-w-2xl">
        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name">
                <Input
                  value={form.business_name}
                  onChange={(e) => set('business_name', e.target.value)}
                  autoFocus
                />
              </Field>
              <Field label="Legal name">
                <Input
                  value={form.legal_name}
                  onChange={(e) => set('legal_name', e.target.value)}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                />
              </Field>
              <Field label="Phone">
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="TIN (optional)">
                <Input value={form.tin} onChange={(e) => set('tin', e.target.value)} />
              </Field>
              <Field label="Registration no. (optional)">
                <Input
                  value={form.registration_number}
                  onChange={(e) => set('registration_number', e.target.value)}
                />
              </Field>
              <Field label="Default business model">
                <select
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                  value={form.default_business_model}
                  onChange={(e) => set('default_business_model', e.target.value as BusinessModel)}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={`Negotiated MDR bps${previewBps(form.mdr_bps_override)}`}>
                  <Input
                    inputMode="numeric"
                    value={form.mdr_bps_override}
                    onChange={(e) => set('mdr_bps_override', e.target.value)}
                    placeholder="Blank: each plan's own rate"
                  />
                </Field>
                <Field label={`Negotiated reserve bps${previewBps(form.reserve_bps_override)}`}>
                  <Input
                    inputMode="numeric"
                    value={form.reserve_bps_override}
                    onChange={(e) => set('reserve_bps_override', e.target.value)}
                    placeholder="Blank: each plan's own rate"
                  />
                </Field>
              </div>
              <Field
                label={`Negotiated paid-in-full commission bps${previewBps(form.commission_bps_override)}`}
              >
                <Input
                  inputMode="numeric"
                  value={form.commission_bps_override}
                  onChange={(e) => set('commission_bps_override', e.target.value)}
                  placeholder="Blank: the platform default"
                />
              </Field>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {create.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(create.error)}</p>
            ) : null}

            <div className="flex gap-2">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create merchant'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate('/merchants')}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
