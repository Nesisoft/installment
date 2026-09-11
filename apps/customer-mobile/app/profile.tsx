import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Header,
  Loading,
  Screen,
  SectionLabel,
  StickyFooter,
  Text,
} from '../src/components';
import { useProfile, useUpdateProfile } from '../src/features/account';
import { longDate, parseApiDate } from '../src/lib/dates';
import { phoneDisplay } from '../src/lib/format';
import { color, radius, space } from '../src/theme/tokens';

/**
 * The shopper's own details.
 *
 * `PATCH /me/profile` existed, `useUpdateProfile` existed, and no screen called
 * either — so a customer's name, email and birthday were read-only for the life
 * of the account.
 *
 * The birthday is why this matters more than it looks. #83 added it to the
 * patch route precisely so an account opened before signup asked could supply
 * one: `gate.age_range` is a hard gate that declines an age it does not know,
 * so a customer with no birthday on file is refused every instalment
 * application no matter what else they do. That fix shipped with the field
 * writable, absent from the profile read, and called by nothing — the remedy
 * existed and the person who needed it could not reach it. This screen is the
 * other half.
 */
export default function ProfileScreen(): React.ReactElement {
  const profile = useProfile();
  const update = useUpdateProfile();

  const me = profile.data;
  const savedFirst = me?.first_name ?? '';
  const savedLast = me?.last_name ?? '';
  const savedEmail = me?.email ?? '';
  const savedDob = me?.date_of_birth ?? null;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The four saved values, never the query object: React Query hands back a new
  // one on every background refetch and depending on it would wipe a half-typed
  // field.
  useEffect(() => {
    setFirstName(savedFirst);
    setLastName(savedLast);
    setEmail(savedEmail);
    const [y, m, d] = (savedDob ?? '').split('-');
    setYear(y ?? '');
    setMonth(m ?? '');
    setDay(d ?? '');
  }, [savedFirst, savedLast, savedEmail, savedDob]);

  if (profile.isPending) {
    return (
      <Screen>
        <Header title="Your details" back />
        <Loading />
      </Screen>
    );
  }

  if (profile.error || !me) {
    return (
      <Screen>
        <Header title="Your details" back />
        <ErrorState
          message={apiErrorMessage(profile.error, 'We could not load your details.')}
          onRetry={() => void profile.refetch()}
        />
      </Screen>
    );
  }

  /**
   * Zero-padded, the way onboarding does it: `4` and `04` are the same April to
   * a person and different strings to an API that takes the ISO shape only.
   */
  const dateOfBirth =
    day && month && year.length === 4
      ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
      : null;
  const dobTyped = Boolean(day || month || year);
  const dobIncomplete = dobTyped && dateOfBirth === null;

  const dirty =
    firstName !== savedFirst ||
    lastName !== savedLast ||
    email !== savedEmail ||
    (dateOfBirth ?? '') !== (savedDob ?? '');
  const complete = firstName.trim().length > 0 && lastName.trim().length > 0 && !dobIncomplete;

  async function save(): Promise<void> {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        // Only when it changed. The server validates it as an adult date of
        // birth, so resending an unchanged one is a needless way to fail.
        ...(dateOfBirth && dateOfBirth !== savedDob ? { date_of_birth: dateOfBirth } : {}),
      });
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not save that.'));
    }
  }

  return (
    <Screen footerHeight={92}>
      <Header title="Your details" back />

      <View style={styles.body}>
        {savedDob === null ? (
          <Card style={styles.prompt}>
            <Text variant="bodyMedium">We do not have your date of birth</Text>
            <Text variant="small" tone="muted" style={styles.promptBody}>
              Ejua lends money, so an application cannot be assessed without it — instalments will
              be declined until it is here. Add it below and it is done.
            </Text>
          </Card>
        ) : null}

        <SectionLabel>Your name</SectionLabel>
        <Field
          label="First name"
          value={firstName}
          onChangeText={setFirstName}
          autoCapitalize="words"
        />
        <Field
          label="Last name"
          value={lastName}
          onChangeText={setLastName}
          autoCapitalize="words"
        />

        <SectionLabel>Date of birth</SectionLabel>
        <View style={styles.dob}>
          <View style={styles.dobPart}>
            <Field
              label="Day"
              value={day}
              onChangeText={setDay}
              keyboardType="number-pad"
              maxLength={2}
              placeholder="14"
            />
          </View>
          <View style={styles.dobPart}>
            <Field
              label="Month"
              value={month}
              onChangeText={setMonth}
              keyboardType="number-pad"
              maxLength={2}
              placeholder="06"
            />
          </View>
          <View style={styles.dobYear}>
            <Field
              label="Year"
              value={year}
              onChangeText={setYear}
              keyboardType="number-pad"
              maxLength={4}
              placeholder="1995"
            />
          </View>
        </View>
        <Text variant="tiny" tone={dobIncomplete ? 'accent' : 'faint'} style={styles.dobHint}>
          {dobIncomplete
            ? 'Fill in all three — day, month and a four-digit year.'
            : savedDob
              ? `On file: ${longDate(parseApiDate(savedDob))}. You must be 18 or over to borrow.`
              : 'You must be 18 or over to open an Ejua account.'}
        </Text>

        <SectionLabel>How we reach you</SectionLabel>
        <Field
          label="Email"
          optional
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder="ama@example.com"
        />
        <View style={styles.locked}>
          <Text variant="eyebrow" tone="faint">
            PHONE
          </Text>
          <Text variant="body">{phoneDisplay(me.phone)}</Text>
          <Text variant="tiny" tone="faint" style={styles.lockedHint}>
            {/* Honest about what this screen cannot do. Changing the number an
                account signs in with is an identity change, not a profile edit,
                and there is no route for it. */}
            Your number is how you sign in, so it cannot be changed here. Contact support if it has
            changed hands.
          </Text>
        </View>

        {error ? (
          <Text variant="tiny" tone="accent">
            {error}
          </Text>
        ) : null}
        {saved && !dirty ? (
          <Text variant="tiny" tone="success">
            Saved.
          </Text>
        ) : null}
      </View>

      <StickyFooter>
        <Button
          label={update.isPending ? 'Saving…' : 'Save'}
          loading={update.isPending}
          disabled={!dirty || !complete || update.isPending}
          onPress={() => void save()}
        />
      </StickyFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.lg, paddingTop: space.md },
  prompt: { backgroundColor: color.warnTint, borderColor: color.warnTint },
  promptBody: { marginTop: space.sm, lineHeight: 20 },
  dob: { flexDirection: 'row', gap: space.md },
  dobPart: { flex: 1 },
  dobYear: { flex: 1.4 },
  dobHint: { lineHeight: 16, marginTop: -space.sm },
  locked: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  lockedHint: { lineHeight: 16, marginTop: space.xs },
});
