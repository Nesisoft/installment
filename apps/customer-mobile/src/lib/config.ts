import Constants from 'expo-constants';

/**
 * Where the API lives.
 *
 * `EXPO_PUBLIC_API_URL` (from `.env`) wins, with `expo.extra.apiBaseUrl` in
 * app.json as the fallback so a build without an env file still points
 * somewhere. Note the emulator trap documented in `.env.example`: an Android
 * emulator cannot reach the host's `localhost`, it needs `10.0.2.2`.
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
  'http://10.0.2.2:3000';

/** Keystore entry holding the session. */
export const SESSION_KEY = 'ejua.customer.session';

/** Where the shopper says they are, until addresses and geolocation drive it. */
export const DEFAULT_CITY = 'Accra';
export const DEFAULT_REGION = 'Greater Accra';
