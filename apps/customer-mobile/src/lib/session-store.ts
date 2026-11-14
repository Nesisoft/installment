import { Platform } from 'react-native';
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

/**
 * The browser's `localStorage`, on the web.
 *
 * SecureStore has no web implementation, so without this the site would fall
 * back to memory and sign the shopper out on every reload — and every return
 * from Paystack, which reloads the page. `localStorage` is what the web apps
 * this site replaces used too. It is readable by any script on the origin, so
 * the site must not load third-party scripts it does not control. A browser
 * that refuses storage (some private modes throw) falls back to memory.
 */
const browser: SecureStorageAdapter = {
  async getItemAsync(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return fallback.getItemAsync(key);
    }
  },
  async setItemAsync(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      await fallback.setItemAsync(key, value);
    }
  },
  async deleteItemAsync(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      await fallback.deleteItemAsync(key);
    }
  },
};

const keystore: SecureStorageAdapter = {
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

export const sessionStore = createSessionStore(
  SESSION_KEY,
  Platform.OS === 'web' ? browser : keystore,
);
