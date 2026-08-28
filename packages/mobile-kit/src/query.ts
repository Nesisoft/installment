import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

/**
 * Shared React Query defaults, tuned for a handset rather than a desktop tab.
 *
 * The differences from the web kit are all about the network: a Ghanaian mobile
 * connection drops and returns constantly, so a failed request is far more
 * likely to be transient than a real error, and data is far more expensive than
 * a stale render.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Longer than the web's 30s: a shopper who taps into a product and back
        // should not re-download the grid they were just looking at.
        staleTime: 60_000,
        // Keep it in memory for a while after the screen unmounts — going back
        // should be instant, not another round trip.
        gcTime: 30 * 60_000,
        retry(failureCount, error) {
          if (isAxiosError(error)) {
            const status = error.response?.status;
            // A 4xx will fail identically however many times we ask.
            if (status && status >= 400 && status < 500) return false;
          }
          return failureCount < 3;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8_000),
        // React Native has no window focus; reconnection is the signal that
        // matters, and it is wired at the app root via NetInfo.
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        // Never blind-retry a mutation: several of them move money, and the
        // idempotency key is minted per attempt by the caller precisely so the
        // caller decides what a retry means.
        retry: false,
      },
    },
  });
}
