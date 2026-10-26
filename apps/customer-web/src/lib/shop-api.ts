import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  Address,
  CartWithItems,
  Category,
  Paginated,
  StorefrontProduct,
  StorefrontProductDetails,
  CheckoutInput,
  CreateAddressInput,
  Customer,
  CustomerPlan,
  DecidedOrder,
  DeliveryQuote,
  InstallmentScheduleRow,
  OrderWithItems,
  PlanQuote,
  PlanTemplate,
  Statement,
} from '@installment/api-types';

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

/**
 * Full-text product search. The API requires a non-empty term.
 *
 * The endpoint returns `{ rows, total }` (the `Paginated<T>` shape api-types
 * declares); the rows are unwrapped here so callers keep working with an array.
 */
export function useProductSearch(q: string) {
  const api = useApi();
  const term = q.trim();
  return useQuery({
    queryKey: ['product-search', term],
    queryFn: async () =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/search', {
          params: { q: term, limit: 50 },
        })
      ).data.rows,
    enabled: term.length > 0,
    placeholderData: (prev) => prev,
  });
}

/**
 * Products in a category (or across the storefront). Search needs a term, so
 * this is what makes "tap a category, see what's in it" possible.
 */
export function useProducts(params: { category_id?: string; limit?: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['products', params],
    queryFn: async () =>
      (
        await api.get<Paginated<StorefrontProduct>>('/storefront/products', {
          params: { limit: 50, ...params },
        })
      ).data.rows,
    placeholderData: (prev) => prev,
  });
}

export function useProduct(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['product', id],
    queryFn: async () =>
      (await api.get<StorefrontProductDetails>(`/storefront/products/${id}`)).data,
    enabled: Boolean(id),
  });
}

/**
 * Courier fee for a saved address. Checkout always submits `fulfilment_method`
 * as the server's default (`courier`) and always sends an address, so this fee
 * is always charged — the page has to show it, and the instalment plan has to
 * be quoted on the amount that includes it.
 */
export function useDeliveryQuote(addressId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['delivery-quote', addressId],
    queryFn: async () =>
      (
        await api.get<DeliveryQuote>('/storefront/delivery-quote', {
          params: { address_id: addressId },
        })
      ).data,
    enabled: Boolean(addressId),
    staleTime: 5 * 60_000,
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

/**
 * What a plan costs on each amount — one quote per order checkout will make.
 * The engine's own schedule generator, server-side: what the customer is shown
 * is what the plan will be. Each distinct amount is asked once, and an amount
 * not yet priced (zero) not at all.
 */
export function usePlanQuotes(amountsPesewas: readonly number[]): (PlanQuote[] | undefined)[] {
  const api = useApi();
  const distinct = [...new Set(amountsPesewas.filter((amount) => amount > 0))];
  const results = useQueries({
    queries: distinct.map((amount) => ({
      queryKey: ['plan-quote', amount],
      queryFn: async () =>
        (await api.post<PlanQuote[]>('/storefront/plan-quote', { amount_pesewas: amount })).data,
      staleTime: 5 * 60_000,
    })),
  });
  return amountsPesewas.map((amount) => results[distinct.indexOf(amount)]?.data);
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
    // The key is supplied by the caller, and required: minting one here would
    // mint a fresh key per retry and defeat the protection entirely. Making it
    // required means a caller that forgets is a type error rather than a
    // silently unprotected checkout.
    // One decided order per store. This was typed as `OrderWithItems[]`, and
    // the page navigated to `/orders/${orders[0].id}` — `undefined`, because the
    // order is `orders[0].order` — so every checkout ended on an error page.
    mutationFn: async ({ idempotencyKey, ...input }: CheckoutInput & { idempotencyKey: string }) =>
      (
        await api.post<DecidedOrder[]>('/me/checkout', input, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data,
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

export function useOrder(id: string, opts: { pollMs?: number } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['order', id],
    queryFn: async () => (await api.get<OrderWithItems>(`/me/orders/${id}`)).data,
    enabled: Boolean(id),
    // A Mobile Money charge the customer approves on their handset is settled by
    // a webhook, not by our response. Poll while one is outstanding so the page
    // flips to paid on its own instead of asking them to refresh — and stop the
    // moment it does, so a settled order cannot leave a timer running.
    refetchInterval: (query) =>
      opts.pollMs && query.state.data?.status === 'pending_payment' ? opts.pollMs : false,
    // Keep polling while the tab is hidden. Approving a Mobile Money prompt
    // means leaving the browser for the MoMo app, which is exactly when the
    // payment lands — and the shared client sets refetchOnWindowFocus: false,
    // so without this the customer comes back to a stale "awaiting payment"
    // page and has to reload to see an order they have already paid for.
    refetchIntervalInBackground: true,
  });
}

/**
 * What a Mobile Money charge answers. An order's charge says `paid`; an
 * instalment's says `succeeded`, or `unknown` when Paystack's answer did not
 * settle it (the verify poll does). A decline is HTTP 200 with `failed`.
 */
export interface OrderChargeResult {
  status: 'paid' | 'succeeded' | 'pending' | 'unknown' | 'failed';
  reference?: string;
  order?: OrderWithItems;
  message?: string;
  failureReason?: string;
}

/**
 * Pay for a pay-in-full order by Mobile Money.
 *
 * `idempotencyKey` is required and owned by the caller, for the same reason as
 * useCheckout and usePayMomo: minting one per call would produce a fresh key on
 * every retry and turn a timed-out charge into a second debit.
 */
export function usePayOrderMomo(orderId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      phone: string;
      provider: 'mtn' | 'tgo' | 'vod';
      idempotencyKey: string;
    }) => {
      const { data } = await api.post<OrderChargeResult>(
        `/me/orders/${orderId}/pay-momo`,
        { phone: args.phone, provider: args.provider },
        { headers: { 'Idempotency-Key': args.idempotencyKey } },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

// --- Plans & payments -------------------------------------------------------

/** The Mobile Money number on file, which instalments are collected from. */
export function useMomoOnFile() {
  const api = useApi();
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () =>
      (await api.get<Pick<Customer, 'momo_phone' | 'momo_provider'>>('/me/profile')).data,
  });
}

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
 * Pay an installment by Mobile Money.
 *
 * `idempotencyKey` is required and supplied by the caller. Minting one here
 * would produce a fresh key on every attempt, which reads as protection and
 * provides none: the whole point is that a retry of a failed or timed-out
 * charge carries the SAME key, so the server replays the original debit rather
 * than making a second one. The caller owns the attempt, so the caller owns
 * the key.
 */
/**
 * Asks for a hosted Paystack page to pay an instalment by card.
 *
 * Card details never reach this app — entry and 3-D Secure happen on Paystack's
 * page, and the reusable authorization comes back on the webhook, which is what
 * lets the next instalment collect without asking the customer at all.
 */
export interface SavedCard {
  id: string;
  last4: string | null;
  brand: string | null;
  bank: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string;
  is_usable: boolean;
  last_used_at: string | null;
  created_at: string;
}

/** The cards on file. The API never returns the chargeable credential itself. */
export function useSavedCards() {
  const api = useApi();
  return useQuery({
    queryKey: ['saved-cards'],
    queryFn: async () => (await api.get<SavedCard[]>('/me/cards')).data,
  });
}

export function useRemoveCard() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cardId: string) => {
      await api.delete(`/me/cards/${cardId}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-cards'] }),
  });
}

export function usePayByCardLink(planId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (scheduleId: string) => {
      const { data } = await api.post<{ url: string; reference: string }>(
        `/me/installments/${scheduleId}/pay-link`,
        {},
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan-schedule', planId] });
    },
  });
}

export function usePayMomo(planId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      scheduleId: string;
      phone?: string;
      provider?: 'mtn' | 'tgo' | 'vod';
      idempotencyKey: string;
    }) => {
      const body = {
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      };
      const { data } = await api.post<OrderChargeResult>(
        `/me/installments/${args.scheduleId}/pay-momo`,
        body,
        { headers: { 'Idempotency-Key': args.idempotencyKey } },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan-schedule', planId] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      // The first number paid with is kept when none is on file (#120).
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
