import { useQuery, type UseQueryResult } from '@tanstack/react-query';
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

/** Browse and filter. Returns a total, which is what "N items" on the header is. */
export function useBrowse(filters: BrowseFilters): UseQueryResult<Paginated<StorefrontProduct>> {
  const api = useApi();
  return useQuery({
    queryKey: ['browse', filters],
    queryFn: async () =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/products', {
          params: { limit: 30, ...filters },
        })
      ).data,
    // Keep the previous page on screen while the next filter loads, so changing
    // a chip does not blank the grid.
    placeholderData: (prev) => prev,
  });
}

export function useSearch(term: string): UseQueryResult<Paginated<StorefrontProduct>> {
  const api = useApi();
  const q = term.trim();
  return useQuery({
    queryKey: ['search', q],
    queryFn: async () =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/search', {
          params: { q, limit: 40, city: DEFAULT_CITY },
        })
      ).data,
    enabled: q.length > 0,
    placeholderData: (prev) => prev,
  });
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
