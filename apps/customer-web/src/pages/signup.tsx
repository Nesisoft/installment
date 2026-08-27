import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import {
  signupStartSchema,
  signupVerifyCodeSchema,
  signupCompleteSchema,
} from '@installment/api-types';
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

type Step = 'phone' | 'code' | 'details';

/**
 * Three steps: prove the number, then fill in the form.
 *
 * The code is checked on its own before the registration form is shown, so a
 * wrong or expired code is caught in the one field it relates to — rather than
 * letting someone type their name, email and consents and only then be told the
 * six digits at the top were wrong. Verifying returns a short-lived ticket, so
 * the five-minute life of the OTP is not also the deadline for filling in a form.
 *
 * Nothing is created until the final step.
 */
export function SignupPage() {
  const { startSignup, verifySignupCode, completeSignup } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [signupToken, setSignupToken] = useState('');
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
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send the code. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = signupVerifyCodeSchema.safeParse({ phone, code });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the 6-digit code');
      return;
    }
    setBusy(true);
    try {
      const { signupToken: ticket } = await verifySignupCode(parsed.data.phone, parsed.data.code);
      setSignupToken(ticket);
      setStep('details');
    } catch (err) {
      // Stay on this step: the code is the only thing that can be wrong here.
      setError(apiErrorMessage(err, 'That code is not right. Check it and try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = signupCompleteSchema.safeParse({
      signupToken,
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

  function restart() {
    setStep('phone');
    setCode('');
    setSignupToken('');
    setError(null);
  }

  const heading =
    step === 'phone'
      ? 'Your phone number'
      : step === 'code'
        ? 'Confirm your number'
        : 'Your details';
  const blurb =
    step === 'phone'
      ? 'We will text you a code to confirm it is yours.'
      : step === 'code'
        ? `Enter the 6-digit code we sent to ${phone}.`
        : 'Your number is confirmed. Tell us who you are.';

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
            <CardTitle>{heading}</CardTitle>
            <CardDescription>{blurb}</CardDescription>
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
            ) : step === 'code' ? (
              <form onSubmit={onVerifyCode} className="space-y-4">
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
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Checking…' : 'Confirm number'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={restart}>
                  Use a different number
                </Button>
              </form>
            ) : (
              <form onSubmit={onCreate} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="first">First name</Label>
                    <Input
                      id="first"
                      autoComplete="given-name"
                      value={form.first_name}
                      onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                      autoFocus
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
                <Button type="button" variant="ghost" className="w-full" onClick={restart}>
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
