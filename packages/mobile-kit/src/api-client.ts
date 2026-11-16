import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody, AuthTokens } from '@installment/api-types';
import type { SessionStore } from './token-store';

/**
 * Routes a signed-out person calls. They never carry a bearer token, and a 401
 * from them — a wrong code, a wrong password — is that answer, not a session
 * that needs refreshing.
 */
const PUBLIC_AUTH_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/customer/otp',
  '/auth/customer/signup',
  '/auth/merchant/signup',
  '/auth/merchant/password-reset',
];

function isPublicAuthPath(url: string | undefined): boolean {
  if (!url) return false;
  return PUBLIC_AUTH_PATHS.some((p) => url.includes(p));
}

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

export interface ApiClientOptions {
  baseURL: string;
  store: SessionStore;
  /** Called when authentication is irrecoverable (refresh failed / no token). */
  onAuthError?: () => void;
  /**
   * Request timeout. Mobile networks fail by hanging rather than by refusing, so
   * a request with no timeout can leave a spinner up indefinitely on a handset
   * that has drifted off coverage.
   */
  timeoutMs?: number;
}

/** Extract a human-readable message from a backend DomainExceptionFilter error. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return 'That took too long. Check your connection and try again.';
    }
    if (!err.response) {
      return "We couldn't reach Ejua. Check your connection and try again.";
    }
    const body = err.response.data as ApiErrorBody | undefined;
    if (body?.message) return body.message;
    if (err.message) return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/** The backend's machine-readable error code, when it sent one. */
export function apiErrorCode(err: unknown): string | undefined {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiErrorBody | undefined;
    return body?.error;
  }
  return undefined;
}

export function apiErrorStatus(err: unknown): number | undefined {
  return axios.isAxiosError(err) ? err.response?.status : undefined;
}

/**
 * The app's HTTP client: bearer auth from the session store, and a single
 * in-flight refresh shared by every 401 so a burst of parallel screen queries
 * cannot rotate the refresh token several times over and log the customer out.
 */
export function createApiClient({
  baseURL,
  store,
  onAuthError,
  timeoutMs = 20_000,
}: ApiClientOptions): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });

  // A bare client (no interceptors) for the refresh call itself, to avoid loops.
  const bare = axios.create({ baseURL, timeout: timeoutMs });
  let refreshPromise: Promise<AuthTokens> | null = null;

  async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const { data } = await bare.post<AuthTokens>('/auth/refresh', { refreshToken });
    await store.updateTokens(data);
    return data;
  }

  instance.interceptors.request.use((config) => {
    const session = store.get();
    if (session?.accessToken && !isPublicAuthPath(config.url)) {
      config.headers.Authorization = `Bearer ${session.accessToken}`;
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as RetryableConfig | undefined;
      const status = error.response?.status;

      // Only attempt recovery for a 401 on a protected, not-yet-retried request.
      if (status !== 401 || !config || config._retried || isPublicAuthPath(config.url)) {
        return Promise.reject(error);
      }

      const session = store.get();
      if (!session?.refreshToken) {
        onAuthError?.();
        return Promise.reject(error);
      }

      try {
        refreshPromise ??= refreshTokens(session.refreshToken);
        const tokens = await refreshPromise;
        refreshPromise = null;
        config._retried = true;
        config.headers.Authorization = `Bearer ${tokens.accessToken}`;
        return instance(config);
      } catch (refreshErr) {
        refreshPromise = null;
        await store.clear();
        onAuthError?.();
        return Promise.reject(refreshErr);
      }
    },
  );

  return instance;
}
