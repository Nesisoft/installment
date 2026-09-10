import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { newIdempotencyKey, useApi } from '@installment/mobile-kit';
import type {
  CardCheckoutSession,
  Address,
  Cart,
  ChargeResult,
  DecidedOrder,
  Order,
  OrderTracking,
  OrderWithPlan,
} from './types';

const CART_KEY = ['cart'];

// --- Cart --------------------------------------------------------------------

export function useCart(enabled = true): UseQueryResult<Cart> {
  const api = useApi();
  return useQuery({
    queryKey: CART_KEY,
    queryFn: async () => (await api.get<Cart>('/me/cart')).data,
    // The storefront is browsable signed out; only fetch a cart once there is
    // a customer to own it.
    enabled,
  });
}

/**
 * Cart mutations all return the whole cart, so the response is written straight
 * into the cache. That is what makes the quantity stepper feel instant without
 * an optimistic update that could disagree with the server about stock.
 */
function useCartMutation<TInput>(
  fn: (api: ReturnType<typeof useApi>, input: TInput) => Promise<Cart>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(api, input),
    onSuccess: (cart) => qc.setQueryData(CART_KEY, cart),
  });
}

export function useAddToCart() {
  return useCartMutation<{ variant_id: string; quantity?: number }>(
    async (api, input) => (await api.post<Cart>('/me/cart/items', { quantity: 1, ...input })).data,
  );
}

export function useSetCartQuantity() {
  return useCartMutation<{ variantId: string; quantity: number }>(
    async (api, input) =>
      (await api.put<Cart>(`/me/cart/items/${input.variantId}`, { quantity: input.quantity })).data,
  );
}

export function useRemoveCartItem() {
  return useCartMutation<string>(
    async (api, variantId) => (await api.delete<Cart>(`/me/cart/items/${variantId}`)).data,
  );
}

// --- Addresses ---------------------------------------------------------------

export function useAddresses(enabled = true): UseQueryResult<Address[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['addresses'],
    queryFn: async () => (await api.get<Address[]>('/me/addresses')).data,
    enabled,
  });
}

/**
 * What the API accepts when saving an address.
 *
 * Named rather than `Omit<Address, 'id'>`, which is what this used to take —
 * and that type was half of a live bug. `Address` declares `area`, `landmark`
 * and `ghanapost_gps` as `string | null`, so `Omit<Address,'id'>` REQUIRED
 * them, forcing the caller to send nulls that the server's `.optional()` then
 * refused. Every save from this app answered 400 (#87). The server takes null
 * or absent now; this type says the same thing, so a form can simply leave a
 * blank field out.
 */
export interface AddressInput {
  recipient: string;
  phone: string;
  region: string;
  city: string;
  area?: string | null;
  landmark?: string | null;
  ghanapost_gps?: string | null;
  is_default?: boolean;
}

export function useCreateAddress() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddressInput) =>
      (await api.post<Address>('/me/addresses', input)).data,
    onSuccess: invalidateAddresses(qc),
  });
}

export function useUpdateAddress() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<AddressInput> & { id: string }) =>
      (await api.patch<Address>(`/me/addresses/${id}`, patch)).data,
    onSuccess: invalidateAddresses(qc),
  });
}

export function useSetDefaultAddress() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<Address>(`/me/addresses/${id}/default`)).data,
    onSuccess: invalidateAddresses(qc),
  });
}

export function useDeleteAddress() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/me/addresses/${id}`);
    },
    onSuccess: invalidateAddresses(qc),
  });
}

/**
 * Everything an address change touches.
 *
 * The delivery quote goes too, and that is the one worth naming: the quote is
 * priced off the address's city and region, so a shopper who fixes a typo in
 * their city and goes back to checkout must not be shown the fee the old
 * spelling was charged. Any write can move the default, so the list is always
 * stale as well — even a rename, since the list is ordered default-first.
 */
function invalidateAddresses(qc: ReturnType<typeof useQueryClient>) {
  return () => {
    void qc.invalidateQueries({ queryKey: ['addresses'] });
    void qc.invalidateQueries({ queryKey: ['delivery-quote'] });
  };
}

// --- Checkout ----------------------------------------------------------------

export interface CheckoutInput {
  payment_type: 'full' | 'installment';
  plan_template_id?: string;
  shipping_address_id?: string;
  fulfilment_method: 'courier' | 'pickup';
  pickup_hub_id?: string;
  /** Owned by the caller so a retry carries the SAME key. See below. */
  idempotencyKey: string;
}

/**
 * Turn the cart into orders, with the credit decision already made.
 *
 * `idempotencyKey` is required and supplied by the caller rather than minted
 * here. Minting one per call would produce a fresh key on every attempt, which
 * reads as protection and provides none: the entire point is that a retry of a
 * timed-out checkout carries the same key, so the server replays the original
 * order instead of opening a second one and a second credit line.
 */
export function useCheckout() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...input }: CheckoutInput) =>
      (
        await api.post<DecidedOrder[]>('/me/checkout', input, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CART_KEY });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['installments'] });
      void qc.invalidateQueries({ queryKey: ['credit'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

/** A key that survives a re-render, so tapping Pay twice reuses it. */
export function checkoutKey(): string {
  return newIdempotencyKey('checkout');
}

// --- Orders ------------------------------------------------------------------

export function useOrders(enabled = true): UseQueryResult<Order[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['orders'],
    queryFn: async () => (await api.get<Order[]>('/me/orders')).data,
    enabled,
  });
}

/**
 * One order, with its plan and schedule attached.
 *
 * Polls while a Mobile Money charge is outstanding. Approving a MoMo prompt
 * means leaving the app for the MoMo dialler, and the charge settles by webhook
 * rather than in our response — so without this the customer comes back to a
 * screen that still says "awaiting payment" for something they have paid.
 */
export function useOrder(
  id: string,
  opts: { pollMs?: number } = {},
): UseQueryResult<OrderWithPlan> {
  const api = useApi();
  return useQuery({
    queryKey: ['order', id],
    queryFn: async () => (await api.get<OrderWithPlan>(`/me/orders/${id}`)).data,
    enabled: Boolean(id),
    refetchInterval: (query) =>
      opts.pollMs &&
      (query.state.data?.status === 'pending_payment' ||
        query.state.data?.status === 'pending_approval')
        ? opts.pollMs
        : false,
    refetchIntervalInBackground: true,
  });
}

export function useOrderTracking(id: string): UseQueryResult<OrderTracking> {
  const api = useApi();
  return useQuery({
    queryKey: ['order-tracking', id],
    queryFn: async () => (await api.get<OrderTracking>(`/me/orders/${id}/tracking`)).data,
    enabled: Boolean(id),
  });
}

/** Pay a pay-in-full order by Mobile Money. Key owned by the caller, as above. */
export function usePayOrderMomo(orderId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { phone?: string; provider?: string; idempotencyKey: string }) => {
      const { idempotencyKey, ...body } = args;
      return (
        await api.post<ChargeResult>(`/me/orders/${orderId}/pay-momo`, body, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

/**
 * Opens a hosted card checkout for a pay-in-full order.
 *
 * Returns Paystack's page rather than charging: a card needs the PAN, the CVV
 * and an issuer 3-D Secure challenge, none of which may touch our servers. The
 * caller opens `authorization_url`, and the order settles by webhook — so the
 * confirmation screen's existing poll is what actually reports success.
 *
 * No idempotency key, unlike the MoMo mutations: this starts no charge. The
 * reference is derived from the order, so calling it twice returns the same
 * session and the customer lands back on the same page.
 */
export function usePayOrderCard(orderId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (args: { callbackUrl?: string } = {}) =>
      (
        await api.post<CardCheckoutSession>(`/me/orders/${orderId}/pay-card`, {
          ...(args.callbackUrl ? { callback_url: args.callbackUrl } : {}),
        })
      ).data,
  });
}

export function useCancelOrder(orderId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason?: string) =>
      (await api.post<Order>(`/me/orders/${orderId}/cancel`, reason ? { reason } : {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}
