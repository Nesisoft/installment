import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, memoryStorage, type Session } from './token-store';

const SESSION: Session = {
  accessToken: 'a1',
  refreshToken: 'r1',
  userId: 'u1',
  userType: 'customer',
  permissions: [],
};

describe('createSessionStore', () => {
  it('serves null until the keystore has been read, then the stored session', async () => {
    const storage = memoryStorage();
    await storage.setItemAsync('k', JSON.stringify(SESSION));

    const store = createSessionStore('k', storage);
    // The keystore is asynchronous — this is the window that would flash the
    // onboarding screen at a signed-in customer if the app did not wait.
    expect(store.get()).toBeNull();

    await store.hydrated();
    expect(store.get()).toEqual(SESSION);
  });

  it('survives a corrupt entry rather than bricking the app', async () => {
    const storage = memoryStorage();
    await storage.setItemAsync('k', '{not json');
    const store = createSessionStore('k', storage);
    await store.hydrated();
    expect(store.get()).toBeNull();
  });

  it('keeps the principal when only the tokens are refreshed', async () => {
    const store = createSessionStore('k', memoryStorage());
    await store.hydrated();
    await store.set(SESSION);
    await store.updateTokens({ accessToken: 'a2', refreshToken: 'r2' });

    expect(store.get()).toEqual({ ...SESSION, accessToken: 'a2', refreshToken: 'r2' });
  });

  it('ignores a token refresh that lands after sign-out', async () => {
    // The dead session must not come back: a refresh in flight when the
    // customer signs out would otherwise resurrect their credentials.
    const store = createSessionStore('k', memoryStorage());
    await store.hydrated();
    await store.set(SESSION);
    await store.clear();
    await store.updateTokens({ accessToken: 'a2', refreshToken: 'r2' });

    expect(store.get()).toBeNull();
  });

  it('notifies subscribers on every change', async () => {
    const store = createSessionStore('k', memoryStorage());
    const seen = vi.fn();
    const unsubscribe = store.subscribe(seen);
    await store.hydrated();

    await store.set(SESSION);
    await store.clear();
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
    await store.set(SESSION);
    const after = seen.mock.calls.length;
    await store.clear();
    expect(seen.mock.calls.length).toBe(after);
  });

  it('keeps working in memory when the keystore throws', async () => {
    // A device with the keystore unavailable should still let the customer use
    // the app for this run, rather than failing every sign-in.
    const broken = {
      getItemAsync: () => Promise.reject(new Error('keystore unavailable')),
      setItemAsync: () => Promise.reject(new Error('keystore unavailable')),
      deleteItemAsync: () => Promise.reject(new Error('keystore unavailable')),
    };
    const store = createSessionStore('k', broken);
    await store.hydrated();
    await store.set(SESSION);
    expect(store.get()).toEqual(SESSION);
  });

  it('persists what it was given so the next cold start finds it', async () => {
    const storage = memoryStorage();
    const first = createSessionStore('k', storage);
    await first.hydrated();
    await first.set(SESSION);

    const second = createSessionStore('k', storage);
    await second.hydrated();
    expect(second.get()).toEqual(SESSION);
  });
});
