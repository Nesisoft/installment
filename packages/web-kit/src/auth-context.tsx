import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AxiosInstance } from 'axios';
import type {
  AuthResult,
  ChangePasswordInput,
  LoginInput,
  OtpStartResult,
  Permission,
  MerchantSignupCompleteInput,
  SignupCompleteInput,
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
  /**
   * Replaces the signed-in user's password. The answer is a fresh session for
   * this device, stored here; every other session for the account ends.
   */
  changePassword: (input: ChangePasswordInput) => Promise<AuthResult>;
  startOtp: (phone: string) => Promise<OtpStartResult>;
  verifyOtp: (phone: string, code: string) => Promise<AuthResult>;
  /** Self-signup step 1: sends a code without creating anything. */
  startSignup: (phone: string) => Promise<OtpStartResult>;
  /**
   * Self-signup step 2: proves the code and returns a short-lived ticket. Still
   * creates nothing — this is what lets the app confirm the phone before asking
   * anyone to fill in a registration form.
   */
  verifySignupCode: (phone: string, code: string) => Promise<{ signupToken: string }>;
  /** Self-signup step 3: ticket + profile creates the account and signs in. */
  completeSignup: (input: SignupCompleteInput) => Promise<AuthResult>;
  // Merchant self-signup: the same three steps against the merchant routes.
  // Separate methods rather than a parameter, because the two flows have
  // separate OTP keyspaces and separately scoped tickets on the server — a
  // shared method taking a "which kind" flag would invite crossing them.
  startMerchantSignup: (phone: string) => Promise<OtpStartResult>;
  verifyMerchantSignupCode: (phone: string, code: string) => Promise<{ signupToken: string }>;
  /** Creates the merchant, its login and its shopfront, and signs them in. */
  completeMerchantSignup: (input: MerchantSignupCompleteInput) => Promise<AuthResult>;
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
    mustChangePassword: result.mustChangePassword,
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
      async changePassword(input) {
        const { data } = await api.post<AuthResult>('/auth/password', input);
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
      async startSignup(phone) {
        const { data } = await api.post<OtpStartResult>('/auth/customer/signup/start', { phone });
        return data;
      },
      async verifySignupCode(phone, code) {
        const { data } = await api.post<{ signupToken: string }>(
          '/auth/customer/signup/verify-code',
          { phone, code },
        );
        return data;
      },
      async completeSignup(input) {
        const { data } = await api.post<AuthResult>('/auth/customer/signup/complete', input);
        store.set(toSession(data));
        return data;
      },
      async startMerchantSignup(phone) {
        const { data } = await api.post<OtpStartResult>('/auth/merchant/signup/start', { phone });
        return data;
      },
      async verifyMerchantSignupCode(phone, code) {
        const { data } = await api.post<{ signupToken: string }>(
          '/auth/merchant/signup/verify-code',
          { phone, code },
        );
        return data;
      },
      async completeMerchantSignup(input) {
        const { data } = await api.post<AuthResult>('/auth/merchant/signup/complete', input);
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
