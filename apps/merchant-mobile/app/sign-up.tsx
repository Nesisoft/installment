import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage } from '@installment/mobile-kit';
import { Button, Field, Screen, Text } from '../src/components';
import {
  useCompleteShopSignup,
  useStartShopSignup,
  useVerifyShopSignupCode,
} from '../src/features/auth';
import { businessDetailsBody, signupPhone } from '../src/lib/signup';
import { color, font, space } from '../src/theme/tokens';

type Step = 'phone' | 'code' | 'business';

const TITLES: Record<Step, string> = {
  phone: 'Open your shop on Ejua',
  code: 'Enter the code',
  business: 'About your business',
};

/**
 * Opening a shop, in three steps: a phone code, then the account.
 *
 * The phone comes first and creates nothing; the account is created on a
 * ticket the server minted for that proven number. What is not asked here is
 * as deliberate as what is: the shop's category, market and region, its Ghana
 * Card documents and its payout number are the onboarding screen, which a new
 * seller lands on straight after, so nothing is asked twice. No commission or
 * reserve rate (the marketplace's terms) and no shop address (derived from the
 * name, and permanent).
 */
export default function SignUpScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const start = useStartShopSignup();
  const verify = useVerifyShopSignupCode();
  const complete = useCompleteShopSignup();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tin, setTin] = useState('');
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
      setStep('business');
    } catch (err) {
      setError(apiErrorMessage(err, 'That code did not match. Check it, or ask for a new one.'));
    }
  }

  async function createShop(): Promise<void> {
    const result = businessDetailsBody(ticket, { businessName, legalName, email, password, tin });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    try {
      await complete.mutateAsync(result.body);
      // Signed in now: straight to what the shop still needs before it can
      // trade, rather than a dashboard of zeros.
      router.replace('/onboarding');
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not create your shop just now. Try again.'));
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
                List your stock, offer instalments, get paid. We will text you a code first —
                nothing is created until it is confirmed.
              </Text>
              <View style={styles.form}>
                <Field
                  dark
                  label="YOUR PHONE NUMBER"
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
                {`Sent to ${phone.trim()}. It expires in a few minutes.`}
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

          {step === 'business' ? (
            <>
              <Text variant="small" tone="onDarkMuted" style={styles.lede}>
                You can set up your shop straight away. It stays private until Ejua has reviewed it.
              </Text>
              <View style={styles.form}>
                <Field
                  dark
                  label="SHOP NAME"
                  hint="What buyers will see. Your shop address is made from this."
                  value={businessName}
                  onChangeText={setBusinessName}
                  placeholder="Auntie Akos Kente"
                  maxLength={200}
                />
                <Field
                  dark
                  label="REGISTERED NAME"
                  hint="Your business's registered name, or your own if it is not registered."
                  value={legalName}
                  onChangeText={setLegalName}
                  placeholder="Akosua Ventures Ltd"
                  maxLength={200}
                />
                <Field
                  dark
                  label="EMAIL"
                  hint="This is how you will sign in."
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@yourshop.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                />
                <Field
                  dark
                  label="PASSWORD"
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
                  label="TIN (OPTIONAL)"
                  hint="Speeds up review. You can leave it blank."
                  value={tin}
                  onChangeText={setTin}
                  placeholder="C0012345678"
                  autoCapitalize="characters"
                  maxLength={60}
                />
                <ErrorLine error={error} />
                <Button
                  label="Create my shop"
                  onPress={() => void createShop()}
                  loading={complete.isPending}
                  disabled={busy}
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
              Already have a shop?{' '}
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
