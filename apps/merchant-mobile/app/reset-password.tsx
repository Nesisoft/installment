import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage } from '@installment/mobile-kit';
import { Button, Field, Screen, Text } from '../src/components';
import {
  useCompletePasswordReset,
  useStartPasswordReset,
  useVerifyPasswordResetCode,
} from '../src/features/auth';
import { newPasswordProblem } from '../src/lib/password';
import { signupPhone } from '../src/lib/signup';
import { color, font, space } from '../src/theme/tokens';

type Step = 'phone' | 'code' | 'password';

const TITLES: Record<Step, string> = {
  phone: 'Forgot your password?',
  code: 'Enter the code',
  password: 'Choose a new password',
};

/**
 * A forgotten password, in three steps: the phone the shop was opened with, the
 * code texted to it, then a new password — after which the seller is signed in.
 *
 * The phone, because signup proved it and this system sends no email. The
 * server answers the first step the same whether or not the number runs a
 * shop, so this screen never says it does: it says a code is on its way *if*.
 */
export default function ResetPasswordScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const start = useStartPasswordReset();
  const verify = useVerifyPasswordResetCode();
  const complete = useCompletePasswordReset();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const busy = start.isPending || verify.isPending || complete.isPending;

  async function sendCode(): Promise<void> {
    const normalised = signupPhone(phone);
    if (!normalised) {
      setError('Enter a Ghana phone number, like 024 455 1338.');
      return;
    }
    setError(null);
    try {
      await start.mutateAsync(normalised);
      setCode('');
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not send a code just now. Try again.'));
    }
  }

  async function checkCode(): Promise<void> {
    const normalised = signupPhone(phone);
    if (!normalised || code.trim().length < 4) return;
    setError(null);
    try {
      setTicket(await verify.mutateAsync({ phone: normalised, code: code.trim() }));
      setStep('password');
    } catch (err) {
      setError(apiErrorMessage(err, 'That code did not match. Check it, or ask for a new one.'));
    }
  }

  async function setNewPassword(): Promise<void> {
    const problem = newPasswordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await complete.mutateAsync({ resetToken: ticket, new_password: password });
      router.replace('/');
    } catch (err) {
      setError(
        apiErrorMessage(err, 'We could not set your password just now. Start again in a moment.'),
      );
    }
  }

  return (
    <Screen dark width="form">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={[styles.body, { paddingTop: insets.top + 48, paddingBottom: insets.bottom }]}>
          <View style={styles.wordmark}>
            <Text style={styles.ejua}>ejua</Text>
            <Text style={styles.sell}>sell</Text>
          </View>
          <Text variant="h1" tone="onDark" style={styles.title}>
            {TITLES[step]}
          </Text>

          {step === 'phone' ? (
            <>
              <Text variant="small" tone="onDarkMuted" style={styles.lede}>
                Enter the phone number you opened your shop with. We will text it a code, and you
                can choose a new password.
              </Text>
              <View style={styles.form}>
                <Field
                  dark
                  label="YOUR SHOP'S PHONE NUMBER"
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="024 455 1338"
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  returnKeyType="go"
                  onSubmitEditing={() => void sendCode()}
                />
                <ErrorLine error={error} />
                <Button
                  label="Send me a code"
                  onPress={() => void sendCode()}
                  loading={start.isPending}
                  disabled={busy || !phone.trim()}
                />
              </View>
            </>
          ) : null}

          {step === 'code' ? (
            <>
              <Text variant="small" tone="onDarkMuted" style={styles.lede}>
                {`If ${phone.trim()} is the number of a shop on Ejua, a code is on its way. It expires in 5 minutes.`}
              </Text>
              <View style={styles.form}>
                <Field
                  dark
                  label="CODE"
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 8))}
                  placeholder="123456"
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  returnKeyType="go"
                  onSubmitEditing={() => void checkCode()}
                />
                <ErrorLine error={error} />
                <Button
                  label="Continue"
                  onPress={() => void checkCode()}
                  loading={verify.isPending}
                  disabled={busy || code.trim().length < 4}
                />
                <Button
                  label="Use a different number"
                  variant="ghost"
                  disabled={busy}
                  onPress={() => {
                    setError(null);
                    setStep('phone');
                  }}
                />
              </View>
            </>
          ) : null}

          {step === 'password' ? (
            <>
              <Text variant="small" tone="onDarkMuted" style={styles.lede}>
                You will be signed in with it straight away, and signed out anywhere else.
              </Text>
              <View style={styles.form}>
                <Field
                  dark
                  label="NEW PASSWORD"
                  hint="At least 8 characters."
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                />
                <Field
                  dark
                  label="NEW PASSWORD AGAIN"
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="••••••••"
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  returnKeyType="go"
                  onSubmitEditing={() => void setNewPassword()}
                />
                <ErrorLine error={error} />
                <Button
                  label="Save and sign in"
                  onPress={() => void setNewPassword()}
                  loading={complete.isPending}
                  disabled={busy || !password || !confirm}
                />
              </View>
            </>
          ) : null}

          <Pressable
            accessibilityRole="link"
            onPress={() => router.replace('/sign-in')}
            style={styles.switch}
          >
            <Text variant="small" tone="onDarkMuted" center>
              Remembered it?{' '}
              <Text variant="smallMedium" tone="primary">
                Sign in
              </Text>
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ErrorLine({ error }: { error: string | null }): React.ReactElement | null {
  if (!error) return null;
  return (
    <Text variant="small" tone="accent" style={styles.error}>
      {error}
    </Text>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: space.xxl },
  wordmark: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  ejua: { fontFamily: font.extrabold, fontSize: 27, color: color.onDark, letterSpacing: -1 },
  sell: { fontFamily: font.bold, fontSize: 13, color: color.primary, letterSpacing: -0.2 },
  title: { marginTop: space.xxl },
  lede: { marginTop: space.sm, maxWidth: 360 },
  form: { marginTop: space.xxl, gap: space.lg },
  error: { marginTop: -space.xs },
  switch: { marginTop: space.xxl, paddingVertical: space.md, marginBottom: space.xl },
});
