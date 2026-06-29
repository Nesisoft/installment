import { useState, type FormEvent } from 'react';
import { useAuth } from '@installment/web-kit';
import { apiErrorMessage } from '@installment/web-kit';
import { otpStartSchema, otpVerifySchema } from '@installment/api-types';
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

export function LoginPage() {
  const { startOtp, verifyOtp } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = otpStartSchema.safeParse({ phone });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid phone number');
      return;
    }
    setBusy(true);
    try {
      await startOtp(parsed.data.phone);
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send the code. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = otpVerifySchema.safeParse({ phone, code });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the 6-digit code');
      return;
    }
    setBusy(true);
    try {
      await verifyOtp(parsed.data.phone, parsed.data.code);
      // Session is set; the router redirects authenticated users away from /login.
    } catch (err) {
      setError(apiErrorMessage(err, 'That code did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Wallet className="size-6" />
          </span>
          <h1 className="text-xl font-semibold text-foreground">Installment</h1>
          <p className="text-sm text-muted-foreground">Pay for what you need, in instalments.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{step === 'phone' ? 'Sign in' : 'Enter your code'}</CardTitle>
            <CardDescription>
              {step === 'phone'
                ? 'We will text a one-time code to your Mobile Money number.'
                : `We sent a 6-digit code to ${phone}.`}
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
              </form>
            ) : (
              <form onSubmit={onVerify} className="space-y-4">
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
                  {busy ? 'Verifying…' : 'Verify & continue'}
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
