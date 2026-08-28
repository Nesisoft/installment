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
  set(session: Session): Promise<void>;
  /** Replace only the tokens (used after a refresh) while keeping the principal. */
  updateTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void>;
  clear(): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Resolves once the persisted session has been read off disk. */
  hydrated(): Promise<void>;
}

/**
 * The persistence primitive a session store writes to.
 *
 * Declared as an interface rather than importing `expo-secure-store` directly so
 * this package stays testable off-device: a test passes an in-memory adapter,
 * the app passes SecureStore.
 */
export interface SecureStorageAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** An in-memory adapter — for tests, and as the fallback when the keystore is unavailable. */
export function memoryStorage(): SecureStorageAdapter {
  const map = new Map<string, string>();
  return {
    async getItemAsync(key) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
  };
}

/**
 * Keychain/Keystore-backed session store.
 *
 * Unlike the web store, reads are asynchronous — the OS keystore is not a
 * synchronous map — so the store hydrates once at startup and serves a
 * synchronous in-memory snapshot afterwards. `hydrated()` is what the auth
 * provider awaits before deciding whether to show the app or the sign-in flow;
 * without it every cold start would flash the onboarding screen at a customer
 * who is already signed in.
 *
 * Writes are serialised through a promise chain so a refresh landing at the same
 * moment as a sign-out cannot interleave and resurrect a dead session.
 */
export function createSessionStore(
  storageKey: string,
  storage: SecureStorageAdapter,
): SessionStore {
  const listeners = new Set<() => void>();
  let cache: Session | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  function parse(raw: string | null): Session | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  const ready = (async () => {
    try {
      cache = parse(await storage.getItemAsync(storageKey));
    } catch {
      // A corrupt or unreadable keystore entry must not brick the app; the
      // customer simply signs in again.
      cache = null;
    }
    emit();
  })();

  function write(session: Session | null): Promise<void> {
    cache = session;
    emit();
    writes = writes.then(async () => {
      try {
        if (session) await storage.setItemAsync(storageKey, JSON.stringify(session));
        else await storage.deleteItemAsync(storageKey);
      } catch {
        /* keystore unavailable — the in-memory session still works for this run */
      }
    });
    return writes as Promise<void>;
  }

  return {
    get: () => cache,
    set: write,
    updateTokens({ accessToken, refreshToken }) {
      if (!cache) return Promise.resolve();
      return write({ ...cache, accessToken, refreshToken });
    },
    clear: () => write(null),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrated: () => ready,
  };
}
