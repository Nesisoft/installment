import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import type { CustomerReturnBucket, CustomerReturnRow, CustomerReturnsPage } from './types';

/**
 * Sending an order back, from the buyer's side.
 *
 * `POST /me/orders/:id/return` and `GET /me/returns` shipped in #76 and had no
 * caller in any client until now, which meant the seller's returns queue (#82)
 * could only ever read empty in production — a whole decision surface built for
 * requests that nothing could make. The withdraw route is new in this slice,
 * because `order_returns.status = 'cancelled'` was declared everywhere and
 * written by nothing.
 */

/** One cache entry per chip, the way `useInstallments` keys by filter. */
const listKey = (bucket: CustomerReturnBucket) => ['returns', bucket] as const;

export function useMyReturns(
  bucket: CustomerReturnBucket = 'all',
  enabled = true,
): UseQueryResult<CustomerReturnsPage> {
  const api = useApi();
  return useQuery({
    queryKey: listKey(bucket),
    queryFn: async () =>
      (
        await api.get<CustomerReturnsPage>('/me/returns', {
          // `all` is the absence of a filter, not a value the API knows.
          params: bucket === 'all' ? undefined : { status: bucket },
        })
      ).data,
    enabled,
  });
}

/**
 * The open return on this order, if there is one.
 *
 * Read off the unfiltered list rather than fetched per order. It is the one
 * eligibility rule the client cannot derive — `payment_type`, `status` and
 * `return_window_ends_at` are all on the order already, and "a request is
 * still open on it" is on none of them. Without this the order screen offers
 * the button again and the buyer takes a 409 they did nothing to earn.
 */
export function useOpenReturnFor(orderId: string, enabled = true): CustomerReturnRow | null {
  const all = useMyReturns('all', enabled);
  return (
    all.data?.rows.find((row) => row.orderId === orderId && row.status === 'requested') ?? null
  );
}

export function useRequestReturn(orderId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) =>
      (await api.post<CustomerReturnRow>(`/me/orders/${orderId}/return`, { reason })).data,
    onSuccess: () => invalidate(qc, orderId),
  });
}

export function useWithdrawReturn() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row: Pick<CustomerReturnRow, 'id' | 'orderId'>) =>
      (await api.post<CustomerReturnRow>(`/me/returns/${row.id}/withdraw`)).data,
    onSuccess: (_data, row) => invalidate(qc, row.orderId),
  });
}

/**
 * Everything a return touches.
 *
 * The whole `['returns']` prefix, because a request or a withdrawal moves a row
 * between chips and changes every count — invalidating only the bucket the
 * buyer is looking at leaves the other chips showing yesterday's numbers. The
 * order and its timeline go too: both `request` and `withdraw` write an
 * `order_events` row, so the tracking screen is stale the moment either lands.
 */
function invalidate(qc: ReturnType<typeof useQueryClient>, orderId: string): void {
  void qc.invalidateQueries({ queryKey: ['returns'] });
  void qc.invalidateQueries({ queryKey: ['order', orderId] });
  void qc.invalidateQueries({ queryKey: ['order-tracking', orderId] });
  void qc.invalidateQueries({ queryKey: ['orders'] });
}
