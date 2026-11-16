import React, { useState } from 'react';
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
import { Button, Screen, Text } from '../src/components';
import { useSignIn } from '../src/features/auth';
import { color, font, radius, space } from '../src/theme/tokens';

export default function SignInScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const signIn = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  async function submit(): Promise<void> {
    if (!canSubmit || signIn.isPending) return;
    setError(null);
    try {
      await signIn.mutateAsync({ email, password });
      router.replace('/');
    } catch (err) {
      // Deliberately one message for a wrong email and a wrong password: saying
      // which was wrong tells anyone with a list of addresses which of them
      // have shops on the marketplace.
      setError(apiErrorMessage(err, 'That email and password did not match an account.'));
    }
  }

  return (
    <Screen dark width="form" scroll={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={[styles.body, { paddingTop: insets.top + 64, paddingBottom: insets.bottom }]}>
          <View style={styles.wordmark}>
            <Text style={styles.ejua}>ejua</Text>
            <Text style={styles.sell}>sell</Text>
          </View>
          <Text variant="h1" tone="onDark" style={styles.title}>
            {/* The same app is the seller website, where "from your phone" is not true. */}
            {Platform.OS === 'web' ? 'Run your shop on Ejua' : 'Run your shop from your phone'}
          </Text>
          <Text variant="small" tone="onDarkMuted" style={styles.lede}>
            Orders, stock and what Ejua owes you. Sign in with the email you opened the shop with.
          </Text>

          <View style={styles.form}>
            <Field
              label="EMAIL"
              value={email}
              onChangeText={setEmail}
              placeholder="you@yourshop.com"
              autoCapitalize="none"
              autoComplete="username"
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Field
              label="PASSWORD"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push('/reset-password')}
              hitSlop={8}
              style={styles.forgot}
            >
              <Text variant="smallMedium" tone="primary">
                Forgot your password?
              </Text>
            </Pressable>
            {error ? (
              <Text variant="small" tone="accent" style={styles.error}>
                {error}
              </Text>
            ) : null}
            <Button
              label="Sign in"
              onPress={() => void submit()}
              loading={signIn.isPending}
              disabled={!canSubmit}
              style={styles.cta}
            />
          </View>

          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('/sign-up')}
            style={styles.footnote}
          >
            <Text variant="small" tone="onDarkMuted" center>
              No shop yet?{' '}
              <Text variant="smallMedium" tone="primary">
                Open one
              </Text>
            </Text>
            <Text variant="tiny" tone="onDarkFaint" center style={styles.footnoteSub}>
              It takes your phone, your business details and a Ghana Card.
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

type FieldProps = React.ComponentProps<typeof TextInput> & { label: string };

function Field({ label, style, ...rest }: FieldProps): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text variant="eyebrow" tone="onDarkFaint">
        {label}
      </Text>
      <TextInput
        {...rest}
        style={[styles.input, style]}
        placeholderTextColor={color.onDarkFaint}
        selectionColor={color.primary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  forgot: { alignSelf: 'flex-start', marginTop: -space.xs },
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: space.xxl },
  wordmark: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  ejua: { fontFamily: font.extrabold, fontSize: 27, color: color.onDark, letterSpacing: -1 },
  sell: { fontFamily: font.bold, fontSize: 13, color: color.primary, letterSpacing: -0.2 },
  title: { marginTop: space.xxxl },
  lede: { marginTop: space.sm, maxWidth: 320 },
  form: { marginTop: space.xxxl, gap: space.lg },
  field: { gap: 6 },
  input: {
    fontFamily: font.medium,
    fontSize: 16,
    color: color.onDark,
    backgroundColor: color.darkRaised,
    borderWidth: 1,
    borderColor: color.darkBorder,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  error: { marginTop: -space.xs },
  cta: { marginTop: space.sm },
  footnote: { marginTop: 'auto', paddingTop: space.xxl, paddingBottom: space.md, gap: 4 },
  footnoteSub: { lineHeight: 17 },
});
