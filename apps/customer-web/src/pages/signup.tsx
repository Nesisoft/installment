import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import { signupStartSchema, signupVerifySchema } from '@installment/api-types';
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
import { Wallet } from 'lucide-react';

/**
 * Verify-then-create: step one only sends a code, so an abandoned signup leaves
 * nothing behind. The profile and consents travel with the code in step two,
 * which is the request that actually creates the account.
 */
export function SignupPage() {
  const { startSignup, completeSignup } = useAuth();
  const [step, setStep] = useState<'phone' | 'details'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '' });
  const [consents, setConsents] = useState({
    data_processing: false,
    credit_scoring: false,
    marketing: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = signupStartSchema.safeParse({ phone });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid phone number');
      return;
    }
    setBusy(true);
    try {
      await startSignup(parsed.data.phone);
      setStep('details');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send the code. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = signupVerifySchema.safeParse({
      phone,
      code,
      first_name: form.first_name,
      last_name: form.last_name,
      ...(form.email ? { email: form.email } : {}),
      consents,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your details');
      return;
    }
    setBusy(true);
    try {
      await completeSignup(parsed.data);
      // Session is set; the router sends authenticated users to the shop.
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not create your account. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Wallet className="size-6" />
          </span>
          <h1 className="text-xl font-semibold text-foreground">Create your account</h1>
          <p className="text-sm text-muted-foreground">Shop now and pay in instalments.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{step === 'phone' ? 'Your phone number' : 'Your details'}</CardTitle>
            <CardDescription>
              {step === 'phone'
                ? 'We will text you a code to confirm it is yours.'
                : `Enter the code we sent to ${phone}, and tell us who you are.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === 'phone' ? (
              <form onSubmit={onSendCode} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="024 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoFocus
                  />
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Sending…' : 'Send code'}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{' '}
                  <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                    Sign in
                  </Link>
                </p>
              </form>
            ) : (
              <form onSubmit={onCreate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="code">6-digit code</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="••••••"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="first">First name</Label>
                    <Input
                      id="first"
                      autoComplete="given-name"
                      value={form.first_name}
                      onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="last">Last name</Label>
                    <Input
                      id="last"
                      autoComplete="family-name"
                      value={form.last_name}
                      onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email (optional)</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </div>

                {/* Consent is per purpose, not one bundled "I accept". */}
                <fieldset className="space-y-2 rounded-md border border-border p-3">
                  <legend className="px-1 text-sm font-medium">Permissions</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={consents.data_processing}
                      onChange={(e) =>
                        setConsents((c) => ({ ...c, data_processing: e.target.checked }))
                      }
                    />
                    <span>
                      I agree to Installment storing and using my personal details to run my
                      account. <span className="text-muted-foreground">(required)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={consents.credit_scoring}
                      onChange={(e) =>
                        setConsents((c) => ({ ...c, credit_scoring: e.target.checked }))
                      }
                    />
                    <span>
                      I agree to a credit check when I ask to pay in instalments.{' '}
                      <span className="text-muted-foreground">(required)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={consents.marketing}
                      onChange={(e) => setConsents((c) => ({ ...c, marketing: e.target.checked }))}
                    />
                    <span>
                      Send me offers and updates.{' '}
                      <span className="text-muted-foreground">(optional)</span>
                    </span>
                  </label>
                </fieldset>

                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Creating your account…' : 'Create account'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setStep('phone');
                    setCode('');
                    setError(null);
                  }}
                >
                  Use a different number
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
