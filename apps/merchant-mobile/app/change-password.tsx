import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '@installment/mobile-kit';
import { Button, Field, Header, Screen, Text } from '../src/components';
import { useChangePassword } from '../src/features/auth';
import { newPasswordProblem } from '../src/lib/password';
import { space } from '../src/theme/tokens';

/**
 * Change the signed-in seller's password.
 *
 * Asks for the current one even though the seller is signed in: a phone left
 * unlocked on the counter must not be enough to lock its owner out. Every
 * other device the seller is signed in on is signed out by the change; this
 * one stays signed in on the fresh session the server answers with.
 */
export default function ChangePasswordScreen(): React.ReactElement {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save(): Promise<void> {
    setDone(false);
    if (!current) {
      setError('Enter your current password.');
      return;
    }
    const problem = newPasswordProblem(next, confirm, current);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await change.mutateAsync({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not change your password just now. Try again.'));
    }
  }

  return (
    <Screen>
      <Header back title="Change password" />
      <View style={styles.body}>
        <Text variant="small" tone="muted">
          You stay signed in here. Anywhere else you are signed in — another phone, a computer — is
          signed out.
        </Text>
        <Field
          label="CURRENT PASSWORD"
          value={current}
          onChangeText={setCurrent}
          placeholder="••••••••"
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
        />
        <Field
          label="NEW PASSWORD"
          hint="At least 8 characters."
          value={next}
          onChangeText={setNext}
          placeholder="••••••••"
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
        />
        <Field
          label="NEW PASSWORD AGAIN"
          value={confirm}
          onChangeText={setConfirm}
          placeholder="••••••••"
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void save()}
        />
        {error ? (
          <Text variant="small" tone="accent">
            {error}
          </Text>
        ) : null}
        {done ? (
          <Text variant="smallMedium" tone="primary" accessibilityRole="alert">
            Password changed. Any other device you were signed in on is signed out.
          </Text>
        ) : null}
        <Button
          label="Change password"
          onPress={() => void save()}
          loading={change.isPending}
          disabled={change.isPending || !current || !next || !confirm}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg },
});
