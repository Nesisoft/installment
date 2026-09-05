import { useQuery } from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import type {
  Merchant,
  MerchantBalances,
  MerchantCatalogSummary,
  MerchantStats,
  OrderWithItems,
} from '@installment/api-types';

/**
 * Everything the seller app reads about the seller's own shop.
 *
 * Every path here is under `/merchant`, which `MerchantScopeGuard` narrows to
 * the signed-in account — the app never sends a merchant id and could not widen
 * its own scope by doing so.
 */

/** A page of the merchant's orders, plus the count the filter matched. */
export interface OrderPage {
  rows: OrderWithItems[];
  total: number;
}

export function useMerchantProfile() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'me'],
    queryFn: async () => (await api.get<Merchant>('/merchant/me')).data,
    staleTime: 5 * 60_000,
  });
}

export function useMerchantBalances() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'balances'],
    queryFn: async () => (await api.get<MerchantBalances>('/merchant/balances')).data,
  });
}

/**
 * Trading figures.
 *
 * The home screen asks for 30 days rather than 7 even though it draws two
 * weeks: `vsSameWeekday` needs the eighth day back, and a 7-day window does not
 * contain it. Asking for a window and slicing it is free; asking for two
 * windows is a second round trip on a mobile connection.
 */
export function useMerchantStats(days: 7 | 30 | 90 = 30) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'stats', days],
    queryFn: async () =>
      (await api.get<MerchantStats>('/merchant/stats', { params: { days } })).data,
  });
}

export function useCatalogSummary() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'catalog', 'summary'],
    queryFn: async () => (await api.get<MerchantCatalogSummary>('/merchant/catalog/summary')).data,
    retry: false,
  });
}

/**
 * How many orders are waiting on the seller.
 *
 * Two statuses, because an order becomes the seller's the moment it is paid for
 * — outright (`paid`) or on a plan Ejua has approved (`financing_active`) — and
 * the API filters on one status at a time. Two calls with `limit: 1` fetch two
 * counts and no rows, which is cheaper than one call fetching every order to
 * count it client-side.
 */
export const AWAITING_CONFIRMATION = ['paid', 'financing_active'] as const;

export function useOrdersAwaitingConfirmation() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'orders', 'awaiting'],
    queryFn: async () => {
      const pages = await Promise.all(
        AWAITING_CONFIRMATION.map(async (status) => {
          const { data } = await api.get<OrderPage>('/merchant/orders', {
            params: { status, limit: 1 },
          });
          return data;
        }),
      );
      return {
        total: pages.reduce((n, page) => n + page.total, 0),
        /** The most recent one, for the home screen's deep link. */
        first: pages.flatMap((page) => page.rows)[0] ?? null,
      };
    },
  });
}
