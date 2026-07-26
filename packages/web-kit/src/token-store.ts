import type { Permission, UserType } from '@installment/api-types';

/** The persisted authenticated session. */
export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  userType: UserType;
  permissions: Permission[];
}

export interface SessionStore {
  /** Reference-stable snapshot (safe for useSyncExternalStore). */
  get(): Session | null;
  set(session: Session): void;
  /** Replace only the tokens (used after a refresh) while keeping principal. */
  updateTokens(tokens: { accessToken: string; refreshToken: string }): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * localStorage-backed session store with an in-memory cache so get() returns a
 * stable reference between changes. The refresh token is the long-lived
 * credential; storing it in localStorage accepts the XSS trade-off documented
 * in the Phase 10 plan (a same-origin BFF with HttpOnly cookies is the
 * hardening path for production).
 */
export function createSessionStore(storageKey: string): SessionStore {
  const listeners = new Set<() => void>();

  function parse(raw: string | null): Session | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  let cache: Session | null =
    typeof localStorage === 'undefined' ? null : parse(localStorage.getItem(storageKey));

  function emit(): void {
    for (const l of listeners) l();
  }

  function write(session: Session | null): void {
    cache = session;
    try {
      if (session) localStorage.setItem(storageKey, JSON.stringify(session));
      else localStorage.removeItem(storageKey);
    } catch {
      /* ignore quota / disabled storage */
    }
    emit();
  }

  // Keep tabs in sync (e.g. logout in one tab logs out the others).
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === storageKey) {
        cache = parse(e.newValue);
        emit();
      }
    });
  }

  return {
    get: () => cache,
    set: write,
    updateTokens({ accessToken, refreshToken }) {
      if (!cache) return;
      write({ ...cache, accessToken, refreshToken });
    },
    clear: () => write(null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
