import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { DevicePlatform, RegisterDeviceInput } from '@installment/api-types';
import {
  registerForPush,
  useAuth,
  type AuthContextValue,
  type PushRegistrationOutcome,
} from '@installment/mobile-kit';
import { color } from '../theme/tokens';

/**
 * The authenticated client, named through the context rather than imported
 * from `axios` — that package is `mobile-kit`'s dependency, not this app's,
 * and pnpm is right to refuse a direct import of it here.
 */
type Api = AuthContextValue['api'];

/**
 * Telling the server where this handset is.
 *
 * `push_devices`, `PushNotifier` and `POST /me/devices` all shipped before
 * this, and every send was a no-op: nothing on either app ever asked Expo for
 * a token, so `listActive` returned `[]` and the notifier took its `noDevices`
 * early return and reported success. `expo-notifications` was a declared
 * dependency of both apps and imported by neither.
 *
 * The decision itself lives in `@installment/mobile-kit` so it can be tested in
 * node; this module is only the binding — which Expo module supplies which
 * fact, and where a tapped notification goes.
 */

/**
 * Expo will not mint a push token without a project id and throws when it is
 * missing, so this is read rather than assumed. It is `undefined` until someone
 * runs `eas init`, which writes `extra.eas.projectId` into app.json — see
 * `README.md`. Until then registration skips, which is the honest outcome: the
 * app has no push credentials, so there is no address to store.
 */
export const EAS_PROJECT_ID: string | undefined =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  Constants.easConfig?.projectId ??
  undefined;

/** Android needs a channel to exist before a notification can make a sound. */
const CHANNEL = 'orders';

/**
 * A notification arriving while the app is open.
 *
 * Shown rather than swallowed. These are delivery events — shipped, out for
 * delivery, delivered — and a shopper watching the order screen is exactly the
 * person who wants to see one land. Set at module scope because a notification
 * can arrive before any component has mounted, and an unset handler means the
 * system drops it.
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/**
 * `push_devices.platform` is a CHECK of exactly these three, so anything Expo
 * runs on that is not a phone registers as `web` rather than being refused by
 * the database with a constraint error nobody would read.
 */
function devicePlatform(): DevicePlatform {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/** The token this run registered, so signing out can take it off the list. */
let registeredToken: string | null = null;

function ports(api: Api) {
  return {
    isPhysicalDevice: Device.isDevice,
    platform: devicePlatform(),
    projectId: EAS_PROJECT_ID,
    appVersion: Application.nativeApplicationVersion,
    deviceName: Device.deviceName,
    getPermission: async () => {
      const { granted, canAskAgain } = await Notifications.getPermissionsAsync();
      return { granted, canAskAgain };
    },
    requestPermission: async () => {
      const { granted, canAskAgain } = await Notifications.requestPermissionsAsync();
      return { granted, canAskAgain };
    },
    getExpoToken: async (projectId: string) =>
      (await Notifications.getExpoPushTokenAsync({ projectId })).data,
    register: (body: RegisterDeviceInput) => api.post('/me/devices', body),
  };
}

async function registerThisHandset(api: Api): Promise<PushRegistrationOutcome> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Order updates',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: color.accent,
      // A delivery notice is worth a buzz; it is the one thing that tells a
      // shopper their parcel moved without them opening the app.
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const outcome = await registerForPush(ports(api));
  if (outcome.status === 'registered') registeredToken = outcome.token;
  return outcome;
}

/**
 * Sign-out: stop sending to this handset.
 *
 * Must run BEFORE the session is cleared — the route is authenticated, and
 * `deactivate` is scoped to the caller so it cannot silence anyone else's
 * phone. Best-effort: a shopper signing out on a bad connection still signs
 * out, and the row is replaced anyway the moment somebody signs in here again,
 * because the token is unique across the whole table.
 */
export async function deregisterThisHandset(api: Api): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  try {
    // Encoded: an Expo token is `ExponentPushToken[...]`, and the brackets are
    // reserved characters that belong to no path segment unescaped.
    await api.delete(`/me/devices/${encodeURIComponent(token)}`);
  } catch {
    // Nothing to tell the shopper. They asked to sign out, not to manage a
    // notification subscription.
  }
}

/**
 * What a tapped notification was about. `data` is set by `PushNotifier`, whose
 * every push so far carries an `orderId`; anything else opens the app and
 * leaves it where it was, which is better than guessing at a route.
 */
function orderIdFrom(data: Record<string, unknown> | undefined): string | null {
  return typeof data?.orderId === 'string' ? data.orderId : null;
}

/**
 * Registers the handset once per launch, and opens what a tap was about.
 *
 * Mounted from the root layout. Once per launch rather than on every
 * foreground: the upsert refreshes `last_seen_at`, but nothing reads it yet,
 * and a POST on every app switch is a cost with no reader.
 */
export function usePushRegistration(): void {
  const { api, signedIn } = useAuth();
  const attempted = useRef(false);

  useEffect(() => {
    if (!signedIn) {
      // A session can also end without passing through the sign-out button —
      // an unrecoverable refresh does it. Forgetting the token here keeps the
      // next person's sign-out from trying to deactivate a row that is now
      // owned by them and was registered by somebody else.
      registeredToken = null;
      // Reset so the next person to sign in on this handset registers their
      // own row. The token is the same; the owner is not.
      attempted.current = false;
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    void registerThisHandset(api);
  }, [api, signedIn]);

  useEffect(() => {
    if (!signedIn) return;

    // A cold start FROM a tap: the response is already waiting, and no
    // listener registered afterwards will ever be called with it.
    const initial = orderIdFrom(
      Notifications.getLastNotificationResponse()?.notification.request.content.data,
    );
    if (initial) {
      // Cleared so a later remount does not navigate a second time to a tap
      // the person has already been taken to.
      Notifications.clearLastNotificationResponse();
      router.push(`/orders/${initial}`);
    }

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const orderId = orderIdFrom(response.notification.request.content.data);
      if (orderId) router.push(`/orders/${orderId}`);
    });
    return () => sub.remove();
  }, [signedIn]);
}
