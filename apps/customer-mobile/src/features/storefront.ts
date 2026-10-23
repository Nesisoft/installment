import {
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import { DEFAULT_CITY } from '../lib/config';
import type {
  DeliveryQuote,
  HomeFeed,
  Paginated,
  PickupHub,
  PlanQuote,
  StorefrontCategory,
  StorefrontProduct,
  StorefrontProductDetails,
  StorefrontReview,
  StorefrontStore,
  TrendingTerm,
} from './types';

/** Sort orders the filter sheet offers, in the order it lists them. */
export const SORTS = [
  { value: 'popular', label: 'Popular' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Top rated' },
] as const;

export type SortValue = (typeof SORTS)[number]['value'];

export interface BrowseFilters {
  q?: string;
  category_id?: string;
  category_slug?: string;
  store_id?: string;
  sort?: SortValue;
  min_price_pesewas?: number;
  max_price_pesewas?: number;
  installment_only?: boolean;
  in_stock?: boolean;
  /** Only products inside a live deal window — what "Deals · See all" links to. */
  deals_only?: boolean;
  limit?: number;
}

/** The home screen, in one request. */
export function useHomeFeed(): UseQueryResult<HomeFeed> {
  const api = useApi();
  return useQuery({
    queryKey: ['home', DEFAULT_CITY],
    queryFn: async () =>
      (await api.get<HomeFeed>('/storefront/home', { params: { city: DEFAULT_CITY } })).data,
  });
}

export function useCategories(): UseQueryResult<StorefrontCategory[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await api.get<StorefrontCategory[]>('/storefront/categories')).data,
    staleTime: 10 * 60_000,
  });
}

/**
 * How many products one request brings back.
 *
 * Thirty is roughly two and a half screens of the two-column grid — enough
 * that the first page rarely needs a second, small enough to be cheap on a
 * Ghanaian mobile connection where the shopper pays for the bytes.
 */
const PAGE_SIZE = 30;

/**
 * A paged product list, flattened.
 *
 * `select` collapses `InfiniteData` back into the `{ rows, total }` the screens
 * already read, so the three surfaces that page — Browse, Search and a store's
 * shelf — did not have to change how they render. What they gained is
 * `fetchNextPage` and `hasNextPage`.
 */
export type PagedProducts = UseInfiniteQueryResult<Paginated<StorefrontProduct>>;

/**
 * Browse and filter, one page at a time.
 *
 * This sent `limit: 30` and never an `offset`, while the header printed the
 * real total — so a category with 218 listings showed thirty of them and said
 * "218 items" over the top. There was no way to reach the other 188: no
 * pagination control, no infinite scroll, nothing. The API has accepted
 * `offset` since Phase 11.
 *
 * `getNextPageParam` counts the rows actually returned rather than multiplying
 * page number by page size, so it stays correct if the server ever trims a
 * page (a filter applied after the limit, a row that vanished mid-scroll).
 */
export function useBrowse(filters: BrowseFilters): PagedProducts {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['browse', filters],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/products', {
          // `...filters` before `offset` so a caller may set its own page size
          // (the store shelf does) but can never pin the offset.
          params: { limit: PAGE_SIZE, ...filters, offset: pageParam },
        })
      ).data,
    getNextPageParam: nextOffset,
    select: flatten,
    // Keep the previous page on screen while the next filter loads, so changing
    // a chip does not blank the grid.
    placeholderData: (prev) => prev,
  });
}

export function useSearch(term: string): PagedProducts {
  const api = useApi();
  const q = term.trim();
  return useInfiniteQuery({
    queryKey: ['search', q],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/search', {
          params: { q, limit: PAGE_SIZE, city: DEFAULT_CITY, offset: pageParam },
        })
      ).data,
    getNextPageParam: nextOffset,
    select: flatten,
    enabled: q.length > 0,
    placeholderData: (prev) => prev,
  });
}

/** The offset for the next page, or undefined once the total is reached. */
function nextOffset(
  lastPage: Paginated<StorefrontProduct>,
  allPages: Paginated<StorefrontProduct>[],
): number | undefined {
  const loaded = allPages.reduce((n, page) => n + page.rows.length, 0);
  // A page that came back empty means the end, whatever the total claims —
  // without this an over-counting total would loop forever asking for nothing.
  if (lastPage.rows.length === 0) return undefined;
  return loaded < lastPage.total ? loaded : undefined;
}

function flatten(data: { pages: Paginated<StorefrontProduct>[] }): Paginated<StorefrontProduct> {
  return {
    rows: data.pages.flatMap((page) => page.rows),
    // The freshest count, not the first page's: a shopper who has been
    // scrolling for a minute should see the total the server last said.
    total: data.pages[data.pages.length - 1]?.total ?? 0,
  };
}

export function useTrending(): UseQueryResult<TrendingTerm[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['trending', DEFAULT_CITY],
    queryFn: async () =>
      (await api.get<TrendingTerm[]>('/storefront/trending', { params: { city: DEFAULT_CITY } }))
        .data,
    staleTime: 10 * 60_000,
  });
}

export function useProduct(id: string): UseQueryResult<StorefrontProductDetails> {
  const api = useApi();
  return useQuery({
    queryKey: ['product', id],
    queryFn: async () =>
      (await api.get<StorefrontProductDetails>(`/storefront/products/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useProductReviews(id: string): UseQueryResult<Paginated<StorefrontReview>> {
  const api = useApi();
  return useQuery({
    queryKey: ['product-reviews', id],
    queryFn: async () =>
      (await api.get<Paginated<StorefrontReview>>(`/storefront/products/${id}/reviews`)).data,
    enabled: Boolean(id),
  });
}

export function useStore(slug: string): UseQueryResult<StorefrontStore> {
  const api = useApi();
  return useQuery({
    queryKey: ['store', slug],
    queryFn: async () => (await api.get<StorefrontStore>(`/storefront/stores/${slug}`)).data,
    enabled: Boolean(slug),
  });
}

/**
 * What an instalment plan would cost for an amount.
 *
 * This is the engine's own `ScheduleGenerator` running server-side, so the
 * schedule shown on the product and checkout screens is the schedule the plan
 * will actually have. The app deliberately does no instalment arithmetic of its
 * own — an approximation that is a pesewa out is an approximation that argues
 * with the contract.
 */
export function usePlanQuote(
  amountPesewas: number,
  planTemplateIds?: string[],
): UseQueryResult<PlanQuote[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-quote', amountPesewas, planTemplateIds],
    queryFn: async () =>
      (
        await api.post<PlanQuote[]>('/storefront/plan-quote', {
          amount_pesewas: amountPesewas,
          ...(planTemplateIds?.length ? { plan_template_ids: planTemplateIds } : {}),
        })
      ).data,
    enabled: amountPesewas > 0,
    staleTime: 5 * 60_000,
  });
}

/**
 * One quote per amount — a multi-shop basket is several orders, each quoted on
 * its own amount. Same cache key as `usePlanQuote`, so a single-shop basket
 * shares its answer. A zero amount (unpriced) is not fetched.
 */
export function usePlanQuotes(amountsPesewas: readonly number[]): (PlanQuote[] | undefined)[] {
  const api = useApi();
  const results = useQueries({
    queries: amountsPesewas.map((amount) => ({
      queryKey: ['plan-quote', amount, undefined],
      queryFn: async () =>
        (await api.post<PlanQuote[]>('/storefront/plan-quote', { amount_pesewas: amount })).data,
      enabled: amount > 0,
      staleTime: 5 * 60_000,
    })),
  });
  return results.map((r) => r.data);
}

export function usePickupHubs(city = DEFAULT_CITY): UseQueryResult<PickupHub[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['pickup-hubs', city],
    queryFn: async () =>
      (await api.get<PickupHub[]>('/storefront/pickup-hubs', { params: { city } })).data,
    staleTime: 30 * 60_000,
  });
}

/** Delivery fee and arrival window. Quotes against a saved address when given one. */
export function useDeliveryQuote(params: {
  addressId?: string;
  city?: string;
  region?: string;
  enabled?: boolean;
}): UseQueryResult<DeliveryQuote> {
  const api = useApi();
  const { addressId, city, region, enabled = true } = params;
  return useQuery({
    queryKey: ['delivery-quote', addressId, city, region],
    queryFn: async () =>
      (
        await api.get<DeliveryQuote>('/storefront/delivery-quote', {
          params: addressId ? { address_id: addressId } : { city, region },
        })
      ).data,
    enabled: enabled && Boolean(addressId || city || region),
    staleTime: 10 * 60_000,
  });
}

/**
 * The best plan on offer for an amount — what a product card's "or GHS X/week"
 * line quotes. The cheapest weekly commitment wins, because that is the number
 * that makes something feel affordable.
 */
export function bestQuote(quotes: PlanQuote[] | undefined): PlanQuote | null {
  const eligible = (quotes ?? []).filter((q) => q.eligible);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, q) =>
    q.per_installment_pesewas < best.per_installment_pesewas ? q : best,
  );
}
