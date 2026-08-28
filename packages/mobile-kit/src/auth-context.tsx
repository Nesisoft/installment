import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AxiosInstance } from 'axios';
import type { AuthResult } from '@installment/api-types';
import { createApiClient } from './api-client';
import type { Session, SessionStore } from './token-store';

export interface AuthContextValue {
  session: Session | null;
  /** False until the persisted session has been read off the keystore. */
  ready: boolean;
  signedIn: boolean;
  api: AxiosInstance;
  signIn(result: AuthResult): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  baseURL: string;
  store: SessionStore;
  /** Called when a refresh fails and the customer has been signed out. */
  onSignedOut?: () => void;
  children: React.ReactNode;
}

/**
 * Holds the session and the one API client bound to it.
 *
 * `ready` exists because the keystore is asynchronous: without waiting for the
 * first read, every cold start would flash the onboarding screen at a customer
 * who is already signed in, and the router would push them through a sign-up
 * they do not need.
 */
export function AuthProvider({
  baseURL,
  store,
  onSignedOut,
  children,
}: AuthProviderProps): React.ReactElement {
  const [ready, setReady] = useState(false);

  const session = useSyncExternalStore(store.subscribe, store.get, store.get);

  const handleAuthError = useCallback(() => {
    onSignedOut?.();
  }, [onSignedOut]);

  // One client for the app's lifetime. Rebuilding it per render would drop the
  // in-flight refresh promise that stops a burst of 401s rotating the refresh
  // token several times over.
  const api = useMemo(
    () => createApiClient({ baseURL, store, onAuthError: handleAuthError }),
    [baseURL, store, handleAuthError],
  );

  useEffect(() => {
    let cancelled = false;
    void store.hydrated().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const signIn = useCallback(
    async (result: AuthResult) => {
      await store.set({
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        userId: result.userId,
        userType: result.userType,
        permissions: result.permissions,
      });
    },
    [store],
  );

  const signOut = useCallback(async () => {
    await store.clear();
    onSignedOut?.();
  }, [store, onSignedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, ready, signedIn: session !== null, api, signIn, signOut }),
    [session, ready, api, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
}

/** The bearer-authenticated client. */
export function useApi(): AxiosInstance {
  return useAuth().api;
}
