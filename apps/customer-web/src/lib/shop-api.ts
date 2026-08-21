import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  Address,
  CartWithItems,
  Category,
  CheckoutInput,
  CreateAddressInput,
  CustomerPlan,
  InstallmentScheduleRow,
  OrderWithItems,
  PlanTemplate,
  Product,
  ProductDetails,
  Statement,
} from '@installment/api-types';
import { newIdempotencyKey } from './format';

// --- Public storefront ------------------------------------------------------

export function useCategories(topLevel = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['categories', topLevel],
    queryFn: async () =>
      (await api.get<Category[]>('/storefront/categories', { params: { top_level: topLevel } }))
        .data,
    staleTime: 10 * 60_000,
  });
}

/** Full-text product search. The API requires a non-empty term. */
export function useProductSearch(q: string) {
  const api = useApi();
  const term = q.trim();
  return useQuery({
    queryKey: ['product-search', term],
    queryFn: async () =>
      (await api.get<Product[]>('/storefront/search', { params: { q: term, limit: 50 } })).data,
    enabled: term.length > 0,
    placeholderData: (prev) => prev,
  });
}

export function useProduct(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['product', id],
    queryFn: async () => (await api.get<ProductDetails>(`/storefront/products/${id}`)).data,
    enabled: Boolean(id),
  });
}

/** Active installment offers. Public, so the calculator works before sign-in. */
export function usePlanTemplates() {
  const api = useApi();
  return useQuery({
    queryKey: ['storefront-plan-templates'],
    queryFn: async () => (await api.get<PlanTemplate[]>('/storefront/plan-templates')).data,
    staleTime: 10 * 60_000,
  });
}

// --- Cart -------------------------------------------------------------------

const CART_KEY = ['cart'];

export function useCart(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: CART_KEY,
    queryFn: async () => (await api.get<CartWithItems>('/me/cart')).data,
    // The storefront is browsable anonymously; only fetch a cart once signed in.
    enabled,
  });
}

function useCartMutation<TInput>(
  fn: (api: ReturnType<typeof useApi>, input: TInput) => Promise<CartWithItems>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(api, input),
    onSuccess: (cart) => {
      qc.setQueryData(CART_KEY, cart);
    },
  });
}

export function useAddToCart() {
  return useCartMutation<{ variant_id: string; quantity: number }>(async (api, input) => {
    return (await api.post<CartWithItems>('/me/cart/items', input)).data;
  });
}

export function useSetCartQuantity() {
  return useCartMutation<{ variantId: string; quantity: number }>(async (api, input) => {
    return (
      await api.put<CartWithItems>(`/me/cart/items/${input.variantId}`, {
        quantity: input.quantity,
      })
    ).data;
  });
}

export function useRemoveCartItem() {
  return useCartMutation<string>(async (api, variantId) => {
    return (await api.delete<CartWithItems>(`/me/cart/items/${variantId}`)).data;
  });
}

// --- Addresses --------------------------------------------------------------

export function useAddresses() {
  const api = useApi();
  return useQuery({
    queryKey: ['addresses'],
    queryFn: async () => (await api.get<Address[]>('/me/addresses')).data,
  });
}

export function useCreateAddress() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAddressInput) =>
      (await api.post<Address>('/me/addresses', input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['addresses'] }),
  });
}

// --- Checkout & orders ------------------------------------------------------

export function useCheckout() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CheckoutInput) =>
      (await api.post<OrderWithItems[]>('/me/checkout', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CART_KEY });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useOrders() {
  const api = useApi();
  return useQuery({
    queryKey: ['orders'],
    queryFn: async () => (await api.get<OrderWithItems[]>('/me/orders')).data,
  });
}

export function useOrder(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['order', id],
    queryFn: async () => (await api.get<OrderWithItems>(`/me/orders/${id}`)).data,
    enabled: Boolean(id),
  });
}

// --- Plans & payments -------------------------------------------------------

export function usePlans() {
  const api = useApi();
  return useQuery({
    queryKey: ['plans'],
    queryFn: async () => (await api.get<CustomerPlan[]>('/me/plans')).data,
  });
}

export function usePlanSchedule(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-schedule', id],
    queryFn: async () => (await api.get<InstallmentScheduleRow[]>(`/me/plans/${id}/schedule`)).data,
    enabled: Boolean(id),
  });
}

export function usePlanStatement(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-statement', id],
    queryFn: async () => (await api.get<Statement>(`/me/plans/${id}/statement`)).data,
    enabled: Boolean(id),
  });
}

/**
 * Pay an installment by Mobile Money. The endpoint is idempotent-guarded, so we
 * mint one Idempotency-Key per attempt and reuse it on retry — a double-tap or a
 * flaky-network retry must never become a second charge.
 */
export function usePayMomo(planId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      scheduleId: string;
      phone?: string;
      provider?: 'mtn' | 'tgo' | 'vod';
      idempotencyKey?: string;
    }) => {
      const body = {
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      };
      const { data } = await api.post(`/me/installments/${args.scheduleId}/pay-momo`, body, {
        headers: {
          'Idempotency-Key': args.idempotencyKey ?? newIdempotencyKey(`pay-${args.scheduleId}`),
        },
      });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan-schedule', planId] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}
