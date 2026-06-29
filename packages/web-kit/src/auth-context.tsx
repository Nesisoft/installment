import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AxiosInstance } from 'axios';
import type {
  AuthResult,
  LoginInput,
  OtpStartResult,
  Permission,
  UserType,
} from '@installment/api-types';
import { createApiClient } from './api-client';
import { createSessionStore, type Session } from './token-store';

export interface AuthContextValue {
  api: AxiosInstance;
  session: Session | null;
  isAuthenticated: boolean;
  userType: UserType | null;
  permissions: Permission[];
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (permissions: Permission[]) => boolean;
  loginWithPassword: (input: LoginInput) => Promise<AuthResult>;
  startOtp: (phone: string) => Promise<OtpStartResult>;
  verifyOtp: (phone: string, code: string) => Promise<AuthResult>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toSession(result: AuthResult): Session {
  return {
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    userId: result.userId,
    userType: result.userType,
    permissions: result.permissions,
  };
}

export interface AuthProviderProps {
  baseURL: string;
  storageKey: string;
  children: ReactNode;
}

export function AuthProvider({ baseURL, storageKey, children }: AuthProviderProps) {
  const store = useMemo(() => createSessionStore(storageKey), [storageKey]);
  const api = useMemo(
    () => createApiClient({ baseURL, store, onAuthError: () => store.clear() }),
    [baseURL, store],
  );

  const session = useSyncExternalStore(store.subscribe, store.get, store.get);

  const value = useMemo<AuthContextValue>(
    () => ({
      api,
      session,
      isAuthenticated: session !== null,
      userType: session?.userType ?? null,
      permissions: session?.permissions ?? [],
      hasPermission: (permission) => session?.permissions.includes(permission) ?? false,
      hasAnyPermission: (permissions) =>
        permissions.some((p) => session?.permissions.includes(p) ?? false),
      async loginWithPassword(input) {
        const { data } = await api.post<AuthResult>('/auth/login', input);
        store.set(toSession(data));
        return data;
      },
      async startOtp(phone) {
        const { data } = await api.post<OtpStartResult>('/auth/customer/otp/start', { phone });
        return data;
      },
      async verifyOtp(phone, code) {
        const { data } = await api.post<AuthResult>('/auth/customer/otp/verify', { phone, code });
        store.set(toSession(data));
        return data;
      },
      logout() {
        store.clear();
      },
    }),
    [api, session, store],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function useApi(): AxiosInstance {
  return useAuth().api;
}
