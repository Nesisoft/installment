import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AddImageInput,
  AddVariantInput,
  CreateProductInput,
  CustomerPlan,
  InstallmentScheduleRow,
  Inventory,
  MarkDeliveredInput,
  MarkOutForDeliveryInput,
  MarkShippedInput,
  Merchant,
  MerchantBalances,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  MerchantProductDetails,
  MerchantProductImage,
  MerchantProductRow,
  MerchantStatement,
  Order,
  OrderWithItems,
  PlanSettlementView,
  PlanTemplate,
  PresignedUpload,
  Product,
  ProductDetails,
  ProductVariant,
  SetPlanOffersInput,
  Store,
  UpdateProductInput,
} from '@installment/api-types';

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

export function useMerchantPayouts(params: { status?: string; limit?: number; offset?: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'payouts', params],
    queryFn: async () => (await api.get<MerchantPayoutsPage>('/merchant/payouts', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useMerchantReserves(open = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'reserves', open],
    queryFn: async () =>
      (await api.get<MerchantHeldReserveRow[]>('/merchant/reserves', { params: { open } })).data,
  });
}

export function useMerchantStatement(year: number, month: number) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'statement', year, month],
    queryFn: async () =>
      (await api.get<MerchantStatement>('/merchant/statement', { params: { year, month } })).data,
    placeholderData: (prev) => prev,
  });
}

export function useMerchantPlans(params: { status?: string; limit?: number; offset?: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plans', params],
    queryFn: async () => (await api.get<CustomerPlan[]>('/merchant/plans', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useMerchantPlan(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan', id],
    queryFn: async () => (await api.get<CustomerPlan>(`/merchant/plans/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useMerchantPlanSchedule(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-schedule', id],
    queryFn: async () =>
      (await api.get<InstallmentScheduleRow[]>(`/merchant/plans/${id}/schedule`)).data,
    enabled: Boolean(id),
  });
}

export function useMerchantPlanSettlement(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-settlement', id],
    queryFn: async () =>
      (await api.get<PlanSettlementView>(`/merchant/plans/${id}/settlement`)).data,
    enabled: Boolean(id),
  });
}

export function useMerchantPlanTemplates() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-templates'],
    queryFn: async () => (await api.get<PlanTemplate[]>('/merchant/plan-templates')).data,
    staleTime: 5 * 60_000,
  });
}

// --- Orders and fulfilment -------------------------------------------------
//
// Distinct from the plan hooks above, and the distinction is the one this app
// has been getting wrong: a PLAN is an instalment agreement the engine owns; an
// ORDER is the thing somebody bought. A merchant fulfils orders. The two are
// related — an instalment order has a plan — but they are not the same list,
// and the fulfilment actions belong to the order.

export interface MerchantOrdersPage {
  rows: OrderWithItems[];
  total: number;
}

export function useMerchantOrders(params: { status?: string; limit?: number; offset?: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'orders', params],
    queryFn: async () => (await api.get<MerchantOrdersPage>('/merchant/orders', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useMerchantOrder(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'order', id],
    queryFn: async () => (await api.get<OrderWithItems>(`/merchant/orders/${id}`)).data,
    enabled: Boolean(id),
  });
}

/** The steps a merchant walks an order through, in the order they happen. */
export type FulfilmentStep = 'fulfilling' | 'ship' | 'out-for-delivery' | 'delivered';

/**
 * Each step carries the body its own route validates — the union is what stops
 * a tracking code being posted to the route that has no field for it and
 * silently dropped.
 */
export type FulfilOrderArgs =
  | { step: 'fulfilling' }
  | { step: 'ship'; body: MarkShippedInput }
  | { step: 'out-for-delivery'; body: MarkOutForDeliveryInput }
  | { step: 'delivered'; body: MarkDeliveredInput };

/**
 * Moves an order one step along.
 *
 * Answers `Order`, not `OrderWithItems` — the fulfilment routes return the order
 * row alone. Every step invalidates both the order and the list: a merchant
 * marking one shipped is looking at a queue they expect to shorten, and a detail
 * page that disagrees with the list it came from is worse than a slow refetch.
 */
export function useFulfilOrder(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: FulfilOrderArgs) =>
      (
        await api.post<Order>(
          `/merchant/orders/${id}/${args.step}`,
          'body' in args ? args.body : {},
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merchant', 'order', id] });
      void qc.invalidateQueries({ queryKey: ['merchant', 'orders'] });
    },
  });
}

// --- Catalogue -------------------------------------------------------------
//
// Everything here is scoped to the caller by the API, not by a filter this app
// remembers to send: `/merchant/products` returns this merchant's products
// because the guard says so, and another merchant's id in a path answers 404.
// The portal never has to be trusted to ask the right question.

export function useMerchantStore() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'store'],
    queryFn: async () => (await api.get<Store>('/merchant/store')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMerchantProducts(params: { status?: string; limit?: number; offset?: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'products', params],
    queryFn: async () =>
      (await api.get<MerchantProductRow[]>('/merchant/products', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useMerchantProduct(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'product', id],
    queryFn: async () => (await api.get<MerchantProductDetails>(`/merchant/products/${id}`)).data,
    enabled: Boolean(id),
  });
}

/** Invalidates both the product and the list — a rename must not leave the list stale. */
function useProductMutation<TArgs, TResult>(
  id: string | undefined,
  run: (api: ReturnType<typeof useApi>, args: TArgs) => Promise<TResult>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => run(api, args),
    onSuccess: () => {
      if (id) void qc.invalidateQueries({ queryKey: ['merchant', 'product', id] });
      void qc.invalidateQueries({ queryKey: ['merchant', 'products'] });
    },
  });
}

/** `store_id` is omitted on purpose: the API fills it from the caller's own store. */
export type CreateMerchantProductInput = Omit<CreateProductInput, 'store_id'>;

export function useCreateProduct() {
  return useProductMutation<CreateMerchantProductInput, ProductDetails>(
    undefined,
    async (api, body) => (await api.post<ProductDetails>('/merchant/products', body)).data,
  );
}

export function useUpdateProduct(id: string) {
  return useProductMutation<UpdateProductInput, Product>(
    id,
    async (api, patch) => (await api.patch<Product>(`/merchant/products/${id}`, patch)).data,
  );
}

export function useAddVariant(id: string) {
  return useProductMutation<AddVariantInput, ProductVariant>(
    id,
    async (api, body) =>
      (await api.post<ProductVariant>(`/merchant/products/${id}/variants`, body)).data,
  );
}

export function useAddProductImage(id: string) {
  return useProductMutation<AddImageInput, MerchantProductImage>(
    id,
    async (api, body) =>
      (await api.post<MerchantProductImage>(`/merchant/products/${id}/images`, body)).data,
  );
}

export function useSetPlanOffers(id: string) {
  return useProductMutation<SetPlanOffersInput, string[]>(
    id,
    async (api, body) =>
      (await api.put<string[]>(`/merchant/products/${id}/plan-offers`, body)).data,
  );
}

export function useSetStock(productId: string) {
  return useProductMutation<{ variantId: string; quantity_available: number }, Inventory>(
    productId,
    async (api, { variantId, quantity_available }) =>
      (
        await api.put<Inventory>(`/merchant/variants/${variantId}/inventory`, {
          quantity_available,
        })
      ).data,
  );
}

/**
 * Uploads a photo and returns the storage key to attach to a product.
 *
 * Two steps, and the second one deliberately does not go through our own API:
 * the browser PUTs the bytes straight at the URL the server signed, so a 6 MB
 * photograph never passes through the API process. `headers` must be sent
 * verbatim — the content type is part of what was signed, so changing it
 * invalidates the signature rather than merely mislabelling the object.
 */
export function useUploadProductPhoto() {
  const api = useApi();
  return useMutation({
    mutationFn: async (file: File): Promise<string> => {
      const { data: presigned } = await api.post<PresignedUpload>('/merchant/uploads', {
        purpose: 'product_image',
        content_type: file.type,
        content_length: file.size,
      });
      const response = await fetch(presigned.url, {
        method: presigned.method,
        headers: presigned.headers,
        body: file,
      });
      if (!response.ok) {
        throw new Error(`The photo could not be uploaded (${response.status}).`);
      }
      return presigned.key;
    },
  });
}
