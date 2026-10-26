import { useState, type FormEvent } from 'react';
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
} from '@installment/ui';
import { apiErrorMessage } from '@installment/web-kit';
import { setPayoutAccountSchema, type PayoutChangeCodeSent } from '@installment/api-types';
import { BadgeCheck, Clock, Landmark, TriangleAlert } from 'lucide-react';
import {
  usePayoutAccount,
  usePayoutDestinations,
  useResolvePayoutAccount,
  useSendPayoutChangeCode,
  useSetPayoutAccount,
} from '../lib/merchant-api';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

/**
 * Where the marketplace sends a merchant's money.
 *
 * This existed only in the admin console before, and only as a box for a
 * `RCP_…` code someone had already created by hand in the Paystack dashboard.
 * A merchant who signed themselves up could sell, ship and accrue a balance,
 * and every daily settlement run would skip them with "no Paystack recipient
 * code" — a queue that grew in silence.
 *
 * Two steps rather than one, on purpose: the account number is checked with the
 * bank and the name it holds is shown back before anything is saved. A typo
 * then costs a second look at an unfamiliar name, instead of a successful
 * transfer to a stranger.
 *
 * Replacing an account takes a third: a code texted to the phone on the
 * account. A signed-in session alone could otherwise redirect every
 * settlement, and the first payout to a replacement waits 24 hours.
 */
export function PayoutAccountPage() {
  const account = usePayoutAccount();
  const destinations = usePayoutDestinations();

  if (account.isPending || destinations.isPending) return <LoadingState />;
  if (account.isError)
    return <ErrorState error={account.error} onRetry={() => void account.refetch()} />;
  if (destinations.isError) {
    return <ErrorState error={destinations.error} onRetry={() => void destinations.refetch()} />;
  }

  const current = account.data;
  const bankName =
    destinations.data.find((d) => d.code === current.bank_code)?.name ?? current.bank_code;

  return (
    <div className="space-y-6">
      <PageHeader title="Payout account" description="Where your settlements are sent." />

      {current.connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="size-4 text-success" />
              Connected
            </CardTitle>
            <CardDescription>Settlements are paid into this account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">{bankName}</p>
            <p className="text-muted-foreground">
              {current.account_number_masked} · {current.account_name}
            </p>
            {current.payouts_held_until ? (
              <p className="flex items-center gap-2 pt-2 text-muted-foreground">
                <Clock className="size-4 shrink-0" />
                {/* Settlement skips the merchant until then; what is owed
                    stays owed and the next run after it pays all of it. */}
                New account: nothing is paid into it before{' '}
                {formatDateTime(current.payouts_held_until)}. What you are owed until then is paid
                in the first run after.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-warning" />
              No payout account yet
            </CardTitle>
            <CardDescription>
              What you have earned is held, not lost — but nothing can be paid out until you add an
              account below.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <PayoutAccountForm connected={current.connected} />
    </div>
  );
}

function PayoutAccountForm({ connected }: { connected: boolean }) {
  const destinations = usePayoutDestinations();
  const resolve = useResolvePayoutAccount();
  const sendCode = useSendPayoutChangeCode();
  const save = useSetPayoutAccount();

  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [confirmed, setConfirmed] = useState<{ name: string; bankCode: string; number: string }>();
  const [codeSent, setCodeSent] = useState<PayoutChangeCodeSent>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const options = destinations.data ?? [];
  const chosen = options.find((d) => d.code === bankCode);

  /** Any edit invalidates a name that was resolved for the previous entry. */
  function edit(next: { bank?: string; number?: string }) {
    if (next.bank !== undefined) setBankCode(next.bank);
    if (next.number !== undefined) setAccountNumber(next.number);
    setConfirmed(undefined);
    // A code names the account it was sent for, so a new entry needs a new one.
    setCodeSent(undefined);
    setCode('');
    setError(null);
  }

  function onSendCode() {
    if (!confirmed) return;
    setError(null);
    sendCode.mutate(
      { bank_code: confirmed.bankCode, account_number: confirmed.number },
      {
        onSuccess: (sent) => {
          setCodeSent(sent);
          setCode('');
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  }

  function onCheck(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = setPayoutAccountSchema.safeParse({
      bank_code: bankCode,
      account_number: accountNumber,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the account details');
      return;
    }
    resolve.mutate(parsed.data, {
      onSuccess: (r) =>
        setConfirmed({ name: r.account_name, bankCode: r.bank_code, number: r.account_number }),
      onError: (err) => setError(apiErrorMessage(err)),
    });
  }

  function onSave() {
    if (!confirmed) return;
    setError(null);
    save.mutate(
      {
        bank_code: confirmed.bankCode,
        account_number: confirmed.number,
        ...(connected ? { code: code.trim() } : {}),
      },
      {
        onSuccess: () => {
          setBankCode('');
          setAccountNumber('');
          setConfirmed(undefined);
          setCodeSent(undefined);
          setCode('');
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="size-4" />
          {connected ? 'Change the account' : 'Add an account'}
        </CardTitle>
        <CardDescription>
          A bank account or a mobile-money wallet. We check the number with the bank and show you
          the name on it before saving.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onCheck} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bank">Bank or wallet</Label>
            <select
              id="bank"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
              value={bankCode}
              onChange={(e) => edit({ bank: e.target.value })}
            >
              <option value="">Choose…</option>
              {options.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                  {d.kind === 'mobile_money' ? ' (mobile money)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="account">
              {chosen?.kind === 'mobile_money' ? 'Wallet number' : 'Account number'}
            </Label>
            <Input
              id="account"
              inputMode="numeric"
              placeholder={chosen?.kind === 'mobile_money' ? '024 123 4567' : '1234567890123'}
              value={accountNumber}
              onChange={(e) => edit({ number: e.target.value })}
            />
          </div>

          {confirmed ? (
            <div className="space-y-3 rounded-md border border-success/40 bg-success/5 p-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  The bank says this account belongs to
                </p>
                <p className="text-sm font-semibold">{confirmed.name}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                If that is not you, correct the number rather than saving it.
              </p>
              {connected && !codeSent ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Changing where your money goes takes a code we text to the phone on your
                    account. Nothing is paid into the new account for 24 hours after the change.
                  </p>
                  <Button type="button" onClick={onSendCode} disabled={sendCode.isPending}>
                    {sendCode.isPending ? 'Sending…' : 'Text me a code'}
                  </Button>
                </>
              ) : (
                <>
                  {codeSent ? (
                    <div className="space-y-2">
                      <Label htmlFor="code">Code we texted to {codeSent.sent_to}</Label>
                      <Input
                        id="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="w-40"
                      />
                      <button
                        type="button"
                        className="text-sm text-muted-foreground underline"
                        onClick={onSendCode}
                        disabled={sendCode.isPending}
                      >
                        Send a new code
                      </button>
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    onClick={onSave}
                    disabled={save.isPending || (connected && code.trim().length < 4)}
                  >
                    {save.isPending ? 'Saving…' : `Pay my settlements to ${confirmed.name}`}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <Button type="submit" variant="outline" disabled={resolve.isPending}>
              {resolve.isPending ? 'Checking with the bank…' : 'Check this account'}
            </Button>
          )}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {save.isSuccess && !confirmed ? (
            <Badge variant="success">Saved — settlements will use this account.</Badge>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
