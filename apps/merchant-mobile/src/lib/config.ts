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

/**
 * Keystore entry holding the session.
 *
 * Deliberately not the shopper app's key. A phone with both apps installed has
 * two different people's sessions on it as often as one — a seller and whoever
 * shops on that handset — and sharing the entry would sign one out by signing
 * the other in.
 */
export const SESSION_KEY = 'ejua.merchant.session';
