import React, { useCallback, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack, router, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, createQueryClient, useAuth } from '@installment/mobile-kit';
import { fontMap } from '../src/theme/fonts';
import { color } from '../src/theme/tokens';
import { API_BASE_URL } from '../src/lib/config';
import { sessionStore } from '../src/lib/session-store';
import { usePushRegistration } from '../src/lib/push';

// The splash stays up until fonts are loaded and the session has been read off
// the keystore, so the first frame is the right screen rather than a flash of
// onboarding at a customer who is already signed in.
void SplashScreen.preventAutoHideAsync();

const queryClient = createQueryClient();

export default function RootLayout(): React.ReactElement | null {
  const [fontsLoaded, fontError] = useFonts(fontMap);

  const handleSignedOut = useCallback(() => {
    // A refresh that cannot be recovered ends the session. Clear the cache too:
    // the next customer to sign in on this handset must not see the last one's
    // orders while their own load.
    queryClient.clear();
    router.replace('/onboarding');
  }, []);

  // A missing font file must not leave the app on a splash screen forever;
  // React Native falls back to the system face, which is ugly but usable.
  const ready = fontsLoaded || Boolean(fontError);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.canvas }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider baseURL={API_BASE_URL} store={sessionStore} onSignedOut={handleSignedOut}>
            <StatusBar style="auto" />
            {ready ? <Routes /> : null}
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The stack, plus the one redirect rule.
 *
 * Browsing is deliberately open: a shopper can see the catalogue, a product and
 * its instalment terms before signing in, because asking for a phone number
 * before showing anything is how a marketplace loses first-time visitors.
 * Sign-in is required only where the customer's own data starts — cart,
 * checkout, orders, instalments, account.
 */
const PROTECTED = ['cart', 'checkout', 'orders', 'plans', 'wallet', 'account', 'confirmation'];

function Routes(): React.ReactElement | null {
  const { ready, signedIn } = useAuth();
  const segments = useSegments();

  // Inside the provider, so it has the authenticated client, and once for the
  // whole app rather than per screen.
  usePushRegistration();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    if (!ready || signedIn) return;
    const current = segments[segments.length - 1] ?? '';
    const group = segments.find((s) => PROTECTED.includes(s));
    if (group || PROTECTED.includes(current)) {
      router.replace('/onboarding');
    }
  }, [ready, signedIn, segments]);

  if (!ready) return null;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: color.canvas },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
      <Stack.Screen name="search" options={{ animation: 'fade' }} />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="store/[slug]" />
      <Stack.Screen name="checkout" />
      <Stack.Screen name="confirmation/[orderId]" options={{ animation: 'fade' }} />
      <Stack.Screen name="orders/[id]" />
      <Stack.Screen name="plans/index" />
      <Stack.Screen name="wallet" />
    </Stack>
  );
}
