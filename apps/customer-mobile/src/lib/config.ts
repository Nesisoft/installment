import Constants from 'expo-constants';
import { resolveApiBaseUrl } from './api-url';

export { resolveApiBaseUrl, type ApiBaseUrlSources } from './api-url';

const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;

/**
 * Where the API lives. Derived from Metro's own address by default — see
 * `api-url.ts` for why, and for the precedence rules.
 */
export const API_BASE_URL: string = resolveApiBaseUrl({
  explicit: process.env.EXPO_PUBLIC_API_URL,
  hostUri: Constants.expoConfig?.hostUri,
  configured: extra?.apiBaseUrl,
  port: process.env.EXPO_PUBLIC_API_PORT,
});

/** Keystore entry holding the session. */
export const SESSION_KEY = 'ejua.customer.session';

/** Where the shopper says they are, until addresses and geolocation drive it. */
export const DEFAULT_CITY = 'Accra';
export const DEFAULT_REGION = 'Greater Accra';
