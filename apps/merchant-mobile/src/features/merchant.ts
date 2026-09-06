import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import type {
  Merchant,
  MerchantBalances,
  MerchantCatalogSummary,
  MerchantOrderBucket,
  MerchantOrderCounts,
  MerchantOrderDetail,
  MerchantOrderPage,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  MerchantPlanBucket,
  MerchantPlanCounts,
  MerchantPlanDetail,
  MerchantPlanPage,
  MerchantProductRow,
  MerchantStats,
  Order,
  OrderWithItems,
  PayoutAccountView,
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

// --- The order queue ---------------------------------------------------------

/**
 * A page of the queue.
 *
 * `/merchant/queue`, not `/merchant/orders`. The latter filters on one raw
 * order status and is what the web portal uses; this one filters on the
 * seller's own buckets and carries the buyer and what the ledger settled, which
 * the app needs on every card and cannot compute for itself.
 */
/** The service clamps to this; asking for more silently gets you 100. */
export const QUEUE_PAGE_SIZE = 100;

export function useOrderQueue(bucket?: MerchantOrderBucket) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'queue', bucket ?? 'all'],
    queryFn: async () =>
      (
        await api.get<MerchantOrderPage>('/merchant/queue', {
          // Explicit, and the maximum the service allows. The default is 25,
          // and the queue sorts newest first — so a shop with more than 25
          // orders in a bucket could not reach the OLDEST unconfirmed ones,
          // which are exactly the ones a seller most needs to get to. The
          // screen says so when `total` exceeds what came back.
          params: { bucket, limit: QUEUE_PAGE_SIZE },
        })
      ).data,
  });
}

/** The number on each filter chip. One request, not one per chip. */
export function useOrderCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'queue', 'counts'],
    queryFn: async () => (await api.get<MerchantOrderCounts>('/merchant/queue/counts')).data,
  });
}

/** One order with everything the sheet draws, in one round trip. */
export function useOrderSheet(orderId: string | undefined) {
  const api = useApi();
  return useQuery({
    enabled: Boolean(orderId),
    queryKey: ['merchant', 'order', orderId],
    queryFn: async () =>
      (await api.get<MerchantOrderDetail>(`/merchant/orders/${orderId}/sheet`)).data,
  });
}

/**
 * Every write that moves an order along, sharing one cache invalidation.
 *
 * The queue, the counts, the sheet and the home screen's "orders to confirm"
 * are four views of the same fact, so a transition that refreshed only the one
 * on screen would leave a seller looking at a badge for an order they had just
 * confirmed — and tapping it again.
 */
function useOrderTransition<TBody>(path: (orderId: string) => string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, body }: { orderId: string; body?: TBody }) =>
      (await api.post<Order>(path(orderId), body ?? {})).data,
    onSuccess: (_data, { orderId }) => {
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'order', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'orders', 'awaiting'] });
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'balances'] });
    },
  });
}

/**
 * "Confirm order" — the seller has seen it and is packing it.
 *
 * Writes `fulfilling`. There is no `confirmed` order status; "confirm" is what
 * the seller calls this and `fulfilling` is what the state machine calls it.
 */
export function useConfirmOrder() {
  return useOrderTransition<never>((id) => `/merchant/orders/${id}/fulfilling`);
}

export interface MarkShippedBody {
  courier_name?: string;
  courier_phone?: string;
  rider_name?: string;
  tracking_code?: string;
  note?: string;
}

export function useMarkShipped() {
  return useOrderTransition<MarkShippedBody>((id) => `/merchant/orders/${id}/ship`);
}

export function useMarkDelivered() {
  return useOrderTransition<{ note?: string }>((id) => `/merchant/orders/${id}/delivered`);
}

// --- Money -------------------------------------------------------------------

/**
 * Where the seller's payouts go.
 *
 * The number comes back MASKED — `••••3388`, last four only. That is the
 * server's decision, not a formatting choice here: the unmasked account number
 * is never surfaced on the merchant portal, so the canvas's full
 * "024 551 3388" is not something this screen can print.
 */
export function usePayoutAccount() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'payout-account'],
    queryFn: async () => (await api.get<PayoutAccountView>('/merchant/payout-account')).data,
    staleTime: 5 * 60_000,
    // A seller who has not set one up yet gets a 404, which is a state the
    // screen renders rather than an error.
    retry: false,
  });
}

export function usePayouts(limit = 20) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'payouts', limit],
    queryFn: async () =>
      (await api.get<MerchantPayoutsPage>('/merchant/payouts', { params: { limit } })).data,
  });
}

/**
 * Reserve still held, newest first.
 *
 * `open` defaults to true server-side. The screen asks for both: the canvas
 * shows released rows in the same list, greyed, and a seller checking whether
 * last month's reserve ever arrived needs to see it did.
 */
export function useReserves(open: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'reserves', open],
    queryFn: async () =>
      (await api.get<MerchantHeldReserveRow[]>('/merchant/reserves', { params: { open } })).data,
  });
}

// --- Catalogue ---------------------------------------------------------------

/** The catalogue tab's filters. `restock` is a stock fact, not a product status. */
export type CatalogFilter = 'all' | 'live' | 'restock';

/**
 * A page of the seller's own products, each with its variants and their stock.
 *
 * The variants come with the page. Fetching them per card would be one request
 * per product, and a catalogue of thirty is thirty-one round trips on a
 * Ghanaian mobile connection.
 */
export function useCatalog(filter: CatalogFilter) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'catalog', filter],
    queryFn: async () =>
      (
        await api.get<MerchantProductRow[]>('/merchant/products', {
          params: {
            status: filter === 'live' ? 'active' : undefined,
            needs_restock: filter === 'restock' ? true : undefined,
            limit: 100,
          },
        })
      ).data,
  });
}

// --- Credit plans ------------------------------------------------------------

/**
 * The plans running against the seller's sales.
 *
 * `/merchant/plan-list`, not `/merchant/plans`. The latter returns bare
 * `customer_plans` rows — no customer, no product, no schedule, because a plan
 * knows none of it — and is what the web portal uses. This one carries the sale
 * and the schedule summary each card needs.
 */
export function usePlans(bucket: MerchantPlanBucket) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-list', bucket],
    queryFn: async () =>
      (await api.get<MerchantPlanPage>('/merchant/plan-list', { params: { bucket, limit: 200 } }))
        .data,
  });
}

export function usePlanCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-list', 'counts'],
    queryFn: async () => (await api.get<MerchantPlanCounts>('/merchant/plan-list/counts')).data,
  });
}

export function usePlan(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    enabled: Boolean(planId),
    queryKey: ['merchant', 'plan', planId],
    queryFn: async () => (await api.get<MerchantPlanDetail>(`/merchant/plan-list/${planId}`)).data,
  });
}
