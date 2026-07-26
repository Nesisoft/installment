import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody, AuthTokens } from '@installment/api-types';
import type { SessionStore } from './token-store';

const PUBLIC_AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/customer/otp'];

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
}

/** Extract a human-readable message from a backend DomainExceptionFilter error. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiErrorBody | undefined;
    if (body?.message) return body.message;
    if (err.message) return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export function createApiClient({ baseURL, store, onAuthError }: ApiClientOptions): AxiosInstance {
  const instance = axios.create({ baseURL, headers: { 'Content-Type': 'application/json' } });

  // A bare client (no interceptors) for the refresh call itself, to avoid loops.
  const bare = axios.create({ baseURL });
  let refreshPromise: Promise<AuthTokens> | null = null;

  async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const { data } = await bare.post<AuthTokens>('/auth/refresh', { refreshToken });
    store.updateTokens(data);
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
        store.clear();
        onAuthError?.();
        return Promise.reject(refreshErr);
      }
    },
  );

  return instance;
}
