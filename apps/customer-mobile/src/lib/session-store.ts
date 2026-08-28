import * as SecureStore from 'expo-secure-store';
import {
  createSessionStore,
  memoryStorage,
  type SecureStorageAdapter,
} from '@installment/mobile-kit';
import { SESSION_KEY } from './config';

/**
 * SecureStore, behind the kit's storage interface.
 *
 * Availability cannot be probed synchronously (`isAvailableAsync` is a promise,
 * and the store is constructed at module load), so instead each call falls back
 * to an in-memory copy if the keystore throws. That covers Expo Go on web and
 * the occasional device with a broken keystore: the customer stays signed in
 * for the session and signs in again next launch, which is a far better outcome
 * than an app that cannot authenticate at all.
 */
const fallback = memoryStorage();

const adapter: SecureStorageAdapter = {
  async getItemAsync(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return fallback.getItemAsync(key);
    }
  },
  async setItemAsync(key, value) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      await fallback.setItemAsync(key, value);
    }
  },
  async deleteItemAsync(key) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      await fallback.deleteItemAsync(key);
    }
  },
};

export const sessionStore = createSessionStore(SESSION_KEY, adapter);
