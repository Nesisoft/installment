import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import { changePasswordSchema } from '@installment/api-types';
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
import { PageHeader } from '../components/page-header';

/** Where the console sends anyone who must, or wants to, change their password. */
export const CHANGE_PASSWORD_PATH = '/account/password';

/**
 * Change your own password.
 *
 * Also the only page a member of staff on a temporary password can reach: one
 * an administrator chose, when adding them or resetting their password. The
 * API grants such a login no permissions at all until this form succeeds, so
 * the redirect here is a courtesy, not the lock.
 */
export function ChangePasswordPage() {
  const { session, changePassword } = useAuth();
  const navigate = useNavigate();
  const forced = session?.mustChangePassword === true;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const parsed = changePasswordSchema.safeParse({
      current_password: current,
      new_password: next,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the passwords');
      return;
    }
    if (next !== confirm) {
      setError('The new password and its confirmation do not match');
      return;
    }
    setBusy(true);
    try {
      await changePassword(parsed.data);
      setCurrent('');
      setNext('');
      setConfirm('');
      if (forced) navigate('/', { replace: true });
      else setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'Your password could not be changed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={forced ? 'Choose your own password' : 'Change your password'}
        description={
          forced
            ? 'The password you signed in with was set by an administrator. Choose one only you know before you continue.'
            : 'Your other sessions are signed out when you change it; this one stays signed in.'
        }
      />
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">New password</CardTitle>
          <CardDescription>
            At least 8 characters. A passphrase is easier to remember.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">
                {forced ? 'The password you signed in with' : 'Current password'}
              </Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                maxLength={200}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">New password again</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                maxLength={200}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {done ? (
              <p className="text-sm text-success" role="status">
                Password changed. Any other session you had is signed out.
              </p>
            ) : null}
            <Button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
