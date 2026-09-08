import {
  EXPO_PUSH_TOKEN_RE,
  type DevicePlatform,
  type RegisterDeviceInput,
} from '@installment/api-types';

/**
 * Registering a handset for push, as a decision rather than as a side effect.
 *
 * Split from the `expo-notifications` binding for the same reason `api-url.ts`
 * is split from `config.ts`: the interesting part is the sequence of choices —
 * ask or do not ask, mint a token or do not bother, post it or give up — and a
 * unit test in a node environment cannot load a React Native module. So the
 * ports come in as plain functions and the apps supply the real ones.
 *
 * The context this exists in is worth stating. `push_devices`, the transport
 * (`PushNotifier`) and both HTTP routes shipped across two slices, and every
 * send has been a no-op the whole time, because nothing on either handset ever
 * asked Expo for a token. `listActive` returned `[]` for every owner, so
 * `PushNotifier.send` took its `noDevices` early return and reported success.
 * A notification channel that reaches nobody looks exactly like one that works.
 *
 * Never throws. This runs from a root-layout effect on cold start, and an
 * unhandled rejection there is a blank screen — for a feature the app works
 * perfectly well without.
 */

/** What the caller needs from the platform, and nothing more. */
export interface PushRegistrationPorts {
  /**
   * `Device.isDevice`. Expo will not mint a push token for a simulator, and
   * asking anyway throws — so this is a skip, not a failure.
   */
  isPhysicalDevice: boolean;
  platform: DevicePlatform;
  /**
   * `extra.eas.projectId`. `getExpoPushTokenAsync` cannot mint a token without
   * one and throws when it is missing, which for a project that has not run
   * `eas init` is every launch.
   */
  projectId: string | undefined;
  appVersion?: string | null;
  deviceName?: string | null;
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  getExpoToken(projectId: string): Promise<string>;
  /** POSTs the body to `/me/devices` or `/merchant/devices`. */
  register(body: RegisterDeviceInput): Promise<unknown>;
}

export interface PermissionState {
  granted: boolean;
  /**
   * False once the person has said no. Asking again does nothing on either
   * platform — iOS shows the system prompt exactly once per install — so a
   * second attempt is a wasted round trip, not a second chance.
   */
  canAskAgain: boolean;
}

export type PushSkipReason =
  | 'simulator'
  | 'no-project-id'
  | 'permission-denied'
  | 'not-an-expo-token';

export type PushRegistrationOutcome =
  | { status: 'registered'; token: string }
  | { status: 'skipped'; reason: PushSkipReason }
  | { status: 'failed'; error: unknown };

export async function registerForPush(
  ports: PushRegistrationPorts,
): Promise<PushRegistrationOutcome> {
  if (!ports.isPhysicalDevice) return { status: 'skipped', reason: 'simulator' };
  if (!ports.projectId) return { status: 'skipped', reason: 'no-project-id' };

  try {
    // Checked before asking. `requestPermission` on an already-granted app is
    // harmless, but on a denied one it resolves immediately with the same
    // refusal — and on the first launch after an install we do want the prompt.
    let permission = await ports.getPermission();
    if (!permission.granted && permission.canAskAgain) {
      permission = await ports.requestPermission();
    }
    if (!permission.granted) return { status: 'skipped', reason: 'permission-denied' };

    const token = await ports.getExpoToken(ports.projectId);
    // The server's own regex, mirrored in api-types. A device token here means
    // the project's push credentials are wrong; posting it would store an
    // address every send fails against, and the failures are invisible.
    if (!EXPO_PUSH_TOKEN_RE.test(token)) return { status: 'skipped', reason: 'not-an-expo-token' };

    await ports.register({
      expo_token: token,
      platform: ports.platform,
      // Both are `.max()` on the server and a rejected body would cost the
      // whole registration, so a long device name is trimmed rather than sent.
      ...optional('app_version', ports.appVersion, 40),
      ...optional('device_name', ports.deviceName, 120),
    });
    return { status: 'registered', token };
  } catch (error) {
    // Offline, Expo's token service down, a 500 from our own API. All the same
    // from here: no push this run, and the next launch tries again.
    return { status: 'failed', error };
  }
}

function optional(
  key: 'app_version' | 'device_name',
  value: string | null | undefined,
  max: number,
): Record<string, string> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed.slice(0, max) } : {};
}
