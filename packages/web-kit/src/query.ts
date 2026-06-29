import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

/** Shared React Query defaults: don't retry auth/permission errors, sane caching. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry(failureCount, error) {
          if (isAxiosError(error)) {
            const status = error.response?.status;
            if (status === 401 || status === 403 || status === 404) return false;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}
