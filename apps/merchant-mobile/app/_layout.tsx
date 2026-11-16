import React, { useCallback, useEffect } from 'react';
import { Platform, View } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { StatusBar } from 'expo-status-bar';
import { Stack, router } from 'expo-router';
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
import { useLayout } from '../src/lib/layout';
import { WideNav } from '../src/components/WideNav';

// The splash stays up until fonts are loaded and the session has been read off
// the keystore, so the first frame is the right screen rather than a flash of
// sign-in at a seller who is already signed in.
void SplashScreen.preventAutoHideAsync();

// In a browser `react-native-screens` is off by default, so the navigators
// leave screens the seller has moved away from in the page, painted over but
// still reachable by keyboard and screen readers. On, an inactive screen is
// `display: none` and `hidden`, as it already is on a phone.
if (Platform.OS === 'web') enableScreens(true);

const queryClient = createQueryClient();

export default function RootLayout(): React.ReactElement | null {
  const [fontsLoaded, fontError] = useFonts(fontMap);

  const handleSignedOut = useCallback(() => {
    // A refresh that cannot be recovered ends the session. Clear the cache too:
    // this app's every screen is one shop's money, and the next account to sign
    // in on this handset must not see the last one's.
    queryClient.clear();
    router.replace('/sign-in');
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
 * The stack.
 *
 * The whole app is behind sign-in, which is the opposite of the shopper app.
 * There is no browsing here: every screen is one merchant's orders, stock and
 * money, and there is nothing a signed-out visitor could usefully be shown.
 *
 * `Stack.Protected` rather than a redirect in an effect. A redirect runs AFTER
 * the route it is redirecting away from has mounted, and the route the app cold
 * starts on is `(tabs)` — so every launch fired six unauthenticated `/merchant`
 * calls, took six 401s, tripped the client's signed-out handler and only then
 * showed the sign-in screen. A guard takes the routes out of the navigation
 * state instead, so they never mount and never fetch.
 */
function Routes(): React.ReactElement | null {
  const { ready, signedIn } = useAuth();
  const { wide } = useLayout();

  // Inside the provider, so it has the authenticated client, and once for the
  // whole app rather than per screen.
  usePushRegistration();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  // On a wide window the tab bar is hidden and this bar takes its place, above
  // every screen. Only once signed in: sign-in and sign-up carry their own
  // wordmark, and every destination in the bar is behind sign-in.
  return (
    <View style={{ flex: 1 }}>
      {wide && signedIn ? <WideNav /> : null}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.canvas },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="orders/[id]" />
          <Stack.Screen name="plans/index" />
          <Stack.Screen name="plans/[id]" />
          <Stack.Screen name="products/new" />
          <Stack.Screen name="products/[id]" />
          <Stack.Screen name="returns/index" />
          <Stack.Screen name="returns/[id]" />
          <Stack.Screen name="performance" />
          <Stack.Screen name="payout-account" />
          <Stack.Screen name="statements" />
          <Stack.Screen name="change-password" />
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
          <Stack.Screen name="sign-up" />
          <Stack.Screen name="reset-password" />
        </Stack.Protected>
      </Stack>
    </View>
  );
}
