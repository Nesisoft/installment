import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiErrorMessage } from '@installment/mobile-kit';
import { Button, Icon, Text } from '../src/components';
import {
  useCompleteSignup,
  useStartAuth,
  useVerifyLogin,
  useVerifySignupCode,
} from '../src/features/auth';
import { phoneDisplay } from '../src/lib/format';
import { color, radius, space } from '../src/theme/tokens';

type Step = 'phone' | 'code' | 'profile';

/**
 * Sign in, or sign up, from one phone field.
 *
 * The API separates the two — `/auth/customer/otp/*` for an existing customer,
 * `/auth/customer/signup/*` for a new one — but a shopper typing their number
 * does not know which they are, and making them choose is a question they
 * cannot answer. So the screen asks once, discovers which flow applies, and
 * only asks for a name when registration is actually what is happening.
 */
export default function OnboardingScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signupToken = useRef<string | null>(null);

  const start = useStartAuth();
  const verifyLogin = useVerifyLogin();
  const verifyCode = useVerifySignupCode();
  const complete = useCompleteSignup();

  const busy =
    start.isPending || verifyLogin.isPending || verifyCode.isPending || complete.isPending;

  function fail(err: unknown): void {
    setError(apiErrorMessage(err, 'That did not work. Please try again.'));
  }

  async function submitPhone(): Promise<void> {
    setError(null);
    try {
      const result = await start.mutateAsync(phone);
      // Remember which flow we are in — the code step behaves differently for
      // a sign-in (straight in) and a registration (ticket, then profile).
      signupToken.current = result.mode === 'signup' ? '' : null;
      setStep('code');
    } catch (err) {
      fail(err);
    }
  }

  async function submitCode(): Promise<void> {
    setError(null);
    try {
      if (signupToken.current === null) {
        await verifyLogin.mutateAsync({ phone, code });
        router.replace('/');
        return;
      }
      signupToken.current = await verifyCode.mutateAsync({ phone, code });
      setStep('profile');
    } catch (err) {
      setCode('');
      fail(err);
    }
  }

  async function submitProfile(): Promise<void> {
    setError(null);
    if (!signupToken.current) return;
    try {
      await complete.mutateAsync({
        signupToken: signupToken.current,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        marketing,
      });
      router.replace('/');
    } catch (err) {
      fail(err);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[
        styles.root,
        { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl },
      ]}
    >
      <View style={styles.head}>
        <Text variant="h1" tone="onDark">
          ejua
        </Text>
        <View style={styles.regionPill}>
          <Text variant="eyebrow" tone="onDarkFaint">
            GHANA
          </Text>
        </View>
      </View>

      {step === 'phone' ? (
        <View style={styles.pitch}>
          <Text variant="eyebrow" tone="accent">
            BUY NOW · PAY LATER
          </Text>
          <Text variant="display" tone="onDark" style={styles.pitchTitle}>
            Everything you want.{'\n'}Pay small small.
          </Text>
          <Text variant="body" tone="onDarkMuted" style={styles.pitchBody}>
            Shop vendors across Ghana and split an order into weekly payments on Mobile Money. You
            see the exact schedule before you commit.
          </Text>
          <View style={styles.trust}>
            {['Escrow protected', 'MoMo checkout', 'Real schedule up front'].map((t) => (
              <View key={t} style={styles.trustChip}>
                <Icon name="check" size={11} color={color.success} strokeWidth={3} />
                <Text variant="tiny" tone="onDarkMuted">
                  {t}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.pitch}>
          <Text variant="h1" tone="onDark">
            {step === 'code' ? "Confirm it's you" : 'Almost there'}
          </Text>
          <Text variant="body" tone="onDarkMuted" style={styles.pitchBody}>
            {step === 'code'
              ? `We sent a 6-digit code to ${phoneDisplay(phone)}.`
              : 'Tell us who to put on your orders.'}
          </Text>
        </View>
      )}

      <View style={styles.form}>
        {step === 'phone' ? (
          <>
            <Text variant="eyebrow" tone="onDarkFaint">
              MOBILE MONEY NUMBER
            </Text>
            <View style={styles.phoneRow}>
              <Text variant="bodyMedium" tone="onDarkMuted">
                +233
              </Text>
              <View style={styles.divider} />
              <TextInput
                value={phone}
                onChangeText={setPhone}
                placeholder="24 000 0000"
                placeholderTextColor={color.onDarkFaint}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                style={styles.phoneInput}
                accessibilityLabel="Your Mobile Money number"
                onSubmitEditing={() => void submitPhone()}
              />
            </View>
          </>
        ) : null}

        {step === 'code' ? (
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            placeholderTextColor={color.onDarkFaint}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            autoFocus
            maxLength={6}
            style={styles.codeInput}
            accessibilityLabel="The 6-digit code we sent you"
            onSubmitEditing={() => void submitCode()}
          />
        ) : null}

        {step === 'profile' ? (
          <View style={styles.profileFields}>
            <TextInput
              value={firstName}
              onChangeText={setFirstName}
              placeholder="First name"
              placeholderTextColor={color.onDarkFaint}
              autoCapitalize="words"
              autoComplete="given-name"
              style={styles.textInput}
              accessibilityLabel="First name"
            />
            <TextInput
              value={lastName}
              onChangeText={setLastName}
              placeholder="Last name"
              placeholderTextColor={color.onDarkFaint}
              autoCapitalize="words"
              autoComplete="family-name"
              style={styles.textInput}
              accessibilityLabel="Last name"
            />
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: marketing }}
              onPress={() => setMarketing((v) => !v)}
              style={styles.consentRow}
            >
              <View style={[styles.checkbox, marketing && styles.checkboxOn]}>
                {marketing ? (
                  <Icon name="check" size={11} color={color.onDark} strokeWidth={3} />
                ) : null}
              </View>
              <Text variant="small" tone="onDarkMuted" style={styles.consentText}>
                Send me offers and deals. Optional — everything else works either way.
              </Text>
            </Pressable>
          </View>
        ) : null}

        {error ? (
          <Text variant="small" tone="accent" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <Button
          label={step === 'phone' ? 'Continue' : step === 'code' ? 'Verify' : 'Create my account'}
          loading={busy}
          disabled={
            (step === 'phone' && phone.replace(/\D/g, '').length < 9) ||
            (step === 'code' && code.length < 6) ||
            (step === 'profile' && (!firstName.trim() || !lastName.trim()))
          }
          onPress={() => {
            if (step === 'phone') void submitPhone();
            else if (step === 'code') void submitCode();
            else void submitProfile();
          }}
        />

        {step === 'phone' ? (
          <>
            {/* Browsing without an account is deliberate: asking for a phone
                number before showing anything is how a marketplace loses a
                first-time visitor. */}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/')}
              style={styles.browse}
            >
              <Text variant="smallMedium" tone="onDarkMuted">
                Just looking? Browse first
              </Text>
            </Pressable>
            <Text variant="tiny" tone="onDarkFaint" center style={styles.terms}>
              By continuing you agree to Ejua's Terms and to a credit check when you choose to pay
              in instalments.
            </Text>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setError(null);
              setCode('');
              setStep(step === 'profile' ? 'code' : 'phone');
            }}
            style={styles.browse}
          >
            <Text variant="smallMedium" tone="onDarkMuted">
              Back
            </Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.dark, paddingHorizontal: space.xxl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  regionPill: {
    borderWidth: 1,
    borderColor: color.darkBorder,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pitch: { flex: 1, justifyContent: 'center', paddingVertical: space.xxl },
  pitchTitle: { marginTop: space.md },
  pitchBody: { marginTop: space.lg, maxWidth: 320 },
  trust: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xl },
  trustChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.darkRaised,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  form: { gap: space.md },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    height: 56,
  },
  divider: { width: 1, height: 22, backgroundColor: color.darkBorder },
  phoneInput: { flex: 1, color: color.onDark, fontSize: 17, fontFamily: 'Outfit_500Medium' },
  codeInput: {
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    height: 62,
    color: color.onDark,
    fontSize: 26,
    letterSpacing: 12,
    textAlign: 'center',
    fontFamily: 'Outfit_600SemiBold',
  },
  profileFields: { gap: space.md },
  textInput: {
    backgroundColor: color.darkRaised,
    borderRadius: radius.md,
    height: 54,
    paddingHorizontal: space.lg,
    color: color.onDark,
    fontSize: 16,
    fontFamily: 'Outfit_400Regular',
  },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: 4 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    borderWidth: 1.5,
    borderColor: color.darkBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: color.success, borderColor: color.success },
  consentText: { flex: 1 },
  error: { paddingHorizontal: 2 },
  browse: { alignItems: 'center', paddingVertical: space.md },
  terms: { marginTop: -space.sm },
});
