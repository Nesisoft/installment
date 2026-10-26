import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import type { PayoutChangeCodeSent, PayoutDestination } from '@installment/api-types';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Header,
  Loading,
  Note,
  Screen,
  SectionLabel,
  Text,
} from '../src/components';
import {
  usePayoutAccount,
  usePayoutDestinations,
  useResolvePayoutAccount,
  useSendPayoutChangeCode,
  useSetPayoutAccount,
} from '../src/features/merchant';
import { dateTime } from '../src/lib/dates';
import { color, radius, space } from '../src/theme/tokens';

/**
 * Where settlements go, and how to change it.
 *
 * The app could only set a payout account during onboarding, once, and only
 * when there was none: a seller who changed banks or wallets had to find the
 * web console. Changing it is here now, guarded the way the server guards it —
 * the bank's name for the account shown back before anything is saved, a code
 * texted to the phone on the account, and nothing paid into a replacement for
 * 24 hours, so a borrowed or stolen session cannot quietly redirect the money.
 */
export default function PayoutAccountScreen(): React.ReactElement {
  const account = usePayoutAccount();
  const destinations = usePayoutDestinations();

  if (account.isPending || destinations.isPending) {
    return (
      <Screen>
        <Header back title="Payout account" />
        <Loading />
      </Screen>
    );
  }
  const failed = account.error ?? destinations.error;
  if (failed || !account.data || !destinations.data) {
    return (
      <Screen>
        <Header back title="Payout account" />
        <ErrorState
          message={apiErrorMessage(failed, 'Could not load your payout account.')}
          onRetry={() => {
            void account.refetch();
            void destinations.refetch();
          }}
        />
      </Screen>
    );
  }

  const current = account.data;
  const destinationName =
    destinations.data.find((d) => d.code === current.bank_code)?.name ?? current.bank_code;

  return (
    <Screen>
      <Header back title="Payout account" />
      <View style={styles.body}>
        {current.connected ? (
          <Card style={styles.gap}>
            <Text variant="eyebrow" tone="faint">
              PAID INTO
            </Text>
            <Text variant="h3">{current.account_name ?? 'Connected'}</Text>
            <Text variant="small" tone="muted">
              {[destinationName, current.account_number_masked].filter(Boolean).join(' · ')}
            </Text>
          </Card>
        ) : (
          <Note eyebrow="No payout account yet" tone="warn">
            What you have earned is held, not lost — but nothing can be paid out until you add an
            account below.
          </Note>
        )}

        {current.payouts_held_until ? (
          <Note eyebrow="New account" tone="warn">
            {`Nothing is paid into it before ${dateTime(current.payouts_held_until)}. What you are owed until then is paid in full in the first run after.`}
          </Note>
        ) : null}

        <ChangeForm
          connected={current.connected}
          codeRequired={current.code_required}
          destinations={destinations.data}
        />
      </View>
    </Screen>
  );
}

function ChangeForm({
  connected,
  codeRequired,
  destinations,
}: {
  connected: boolean;
  /** A replacement, or a first account while money is owed: both need the code. */
  codeRequired: boolean;
  destinations: PayoutDestination[];
}): React.ReactElement {
  const resolve = useResolvePayoutAccount();
  const sendCode = useSendPayoutChangeCode();
  const save = useSetPayoutAccount();

  const [bankCode, setBankCode] = useState('');
  const [number, setNumber] = useState('');
  const [confirmed, setConfirmed] = useState<{ name: string; bank: string; number: string }>();
  const [codeSent, setCodeSent] = useState<PayoutChangeCodeSent>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** Any edit voids the bank's answer, and the code, which names one account. */
  function edit(next: { bank?: string; number?: string }): void {
    if (next.bank !== undefined) setBankCode(next.bank);
    if (next.number !== undefined) setNumber(next.number);
    setConfirmed(undefined);
    setCodeSent(undefined);
    setCode('');
    setError(null);
    setSaved(false);
  }

  async function check(): Promise<void> {
    setError(null);
    setSaved(false);
    try {
      const r = await resolve.mutateAsync({ bank_code: bankCode, account_number: number });
      setConfirmed({ name: r.account_name, bank: r.bank_code, number: r.account_number });
    } catch (err) {
      setError(apiErrorMessage(err, 'That account could not be checked.'));
    }
  }

  async function text(): Promise<void> {
    if (!confirmed) return;
    setError(null);
    try {
      setCodeSent(
        await sendCode.mutateAsync({ bank_code: confirmed.bank, account_number: confirmed.number }),
      );
      setCode('');
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not send the code.'));
    }
  }

  async function commit(): Promise<void> {
    if (!confirmed) return;
    setError(null);
    try {
      await save.mutateAsync({
        bank_code: confirmed.bank,
        account_number: confirmed.number,
        ...(codeRequired ? { code: code.trim() } : {}),
      });
      setBankCode('');
      setNumber('');
      setConfirmed(undefined);
      setCodeSent(undefined);
      setCode('');
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save that.'));
    }
  }

  const wallets = destinations.filter((d) => d.kind === 'mobile_money');
  const banks = destinations.filter((d) => d.kind === 'bank');

  return (
    <View style={styles.gap}>
      <SectionLabel>{connected ? 'Change it' : 'Add one'}</SectionLabel>

      <Text variant="eyebrow" tone="faint">
        MOBILE MONEY
      </Text>
      <Chips list={wallets} value={bankCode} onChange={(b) => edit({ bank: b })} />
      <Text variant="eyebrow" tone="faint" style={styles.top}>
        OR A BANK
      </Text>
      <Chips list={banks} value={bankCode} onChange={(b) => edit({ bank: b })} />

      <Field
        label="NUMBER"
        value={number}
        onChangeText={(v) => edit({ number: v })}
        placeholder="024 551 3388"
        keyboardType="number-pad"
      />

      {confirmed ? (
        <Note eyebrow="The bank says" tone="primary">
          {`${confirmed.name}. If that is not you, check the number before going on.`}
        </Note>
      ) : null}

      {!confirmed ? (
        <Button
          label={resolve.isPending ? 'Checking…' : 'Check this account'}
          variant="outline"
          disabled={!bankCode || number.trim().length < 5 || resolve.isPending}
          onPress={() => void check()}
        />
      ) : codeRequired && !codeSent ? (
        <>
          <Note>
            Changing where your money goes takes a code we text to the phone on your account.
            Nothing is paid into the new account for 24 hours after the change.
          </Note>
          <Button
            label={sendCode.isPending ? 'Sending…' : 'Text me a code'}
            disabled={sendCode.isPending}
            onPress={() => void text()}
          />
        </>
      ) : (
        <>
          {codeSent ? (
            <Field
              label="CODE"
              hint={`Sent to ${codeSent.sent_to}.`}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              maxLength={8}
            />
          ) : null}
          <Button
            label={save.isPending ? 'Saving…' : `Pay me here`}
            disabled={save.isPending || (codeRequired && code.trim().length < 4)}
            onPress={() => void commit()}
          />
          {codeSent ? (
            <Button
              label="Send a new code"
              variant="ghost"
              disabled={sendCode.isPending}
              onPress={() => void text()}
            />
          ) : null}
        </>
      )}

      {error ? (
        <Text variant="tiny" tone="accent">
          {error}
        </Text>
      ) : null}
      {saved ? (
        <Note tone="primary">Saved. Settlements will be paid into this account.</Note>
      ) : null}
    </View>
  );
}

function Chips({
  list,
  value,
  onChange,
}: {
  list: PayoutDestination[];
  value: string;
  onChange: (code: string) => void;
}): React.ReactElement {
  if (list.length === 0) {
    return (
      <Text variant="tiny" tone="faint">
        None available.
      </Text>
    );
  }
  return (
    <View style={styles.chips}>
      {list.map((d) => {
        const on = d.code === value;
        return (
          <Pressable
            key={d.code}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(d.code)}
            style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
          >
            <Text variant="tiny" tone={on ? undefined : 'soft'} style={on ? styles.onText : null}>
              {d.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg },
  gap: { gap: space.sm },
  top: { marginTop: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipOn: { backgroundColor: color.primary, borderColor: color.primary },
  chipOff: { backgroundColor: color.surface, borderColor: color.border },
  onText: { color: color.onDark },
});
