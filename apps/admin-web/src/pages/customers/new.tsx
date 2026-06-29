import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, CardContent, Input, Label } from '@installment/ui';
import { registerCustomerSchema } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import { useRegisterCustomer } from '../../lib/customers-api';
import { PageHeader } from '../../components/page-header';

export function CustomerNewPage() {
  const navigate = useNavigate();
  const register = useRegisterCustomer();
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    date_of_birth: '',
  });
  const [consents, setConsents] = useState({
    data_processing: false,
    credit_scoring: false,
    marketing: false,
  });
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = {
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email,
      phone: form.phone,
      ...(form.date_of_birth ? { date_of_birth: form.date_of_birth } : {}),
      consents,
    };
    const parsed = registerCustomerSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    register.mutate(parsed.data, { onSuccess: (c) => navigate(`/customers/${c.id}`) });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to customers
      </Link>
      <PageHeader title="New customer" description="Register a borrower." />

      <Card className="max-w-2xl">
        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>First name</Label>
                <Input
                  value={form.first_name}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label>Last name</Label>
                <Input
                  value={form.last_name}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="024 123 4567"
                />
              </div>
              <div className="space-y-2">
                <Label>Date of birth (optional)</Label>
                <Input
                  type="date"
                  value={form.date_of_birth}
                  onChange={(e) => setForm((f) => ({ ...f, date_of_birth: e.target.value }))}
                />
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Consents</legend>
              {(
                [
                  ['data_processing', 'Data processing'],
                  ['credit_scoring', 'Credit scoring'],
                  ['marketing', 'Marketing'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={consents[key]}
                    onChange={(e) => setConsents((c) => ({ ...c, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {register.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(register.error)}</p>
            ) : null}

            <div className="flex gap-2">
              <Button type="submit" disabled={register.isPending}>
                {register.isPending ? 'Registering…' : 'Register customer'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate('/customers')}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
