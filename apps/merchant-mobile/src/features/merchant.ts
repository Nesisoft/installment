import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorStatus, useApi } from '@installment/mobile-kit';
import type { StatementPeriod } from '../lib/statement-period';
import type {
  AddVariantInput,
  CreateProductInput,
  Inventory,
  Merchant,
  MerchantBalances,
  MerchantCatalogSummary,
  MerchantOrderBucket,
  MerchantOrderCounts,
  MerchantOrderDetail,
  MerchantOrderPage,
  MerchantHeldReserveRow,
  MerchantKycDocType,
  MerchantKycDocument,
  MerchantKycStatus,
  MerchantPayoutsPage,
  MerchantPlanBucket,
  MerchantPlanCounts,
  MerchantProfile,
  MerchantPlanDetail,
  MerchantPlanPage,
  MerchantProductDetails,
  MerchantProductImage,
  MerchantProductRow,
  MerchantReturnBucket,
  MerchantReturnCounts,
  MerchantReturnDetail,
  MerchantReturnPage,
  MerchantStats,
  MerchantStore,
  Order,
  OrderReturn,
  OrderWithItems,
  PayoutAccountView,
  PayoutChangeCodeSent,
  PayoutDestination,
  PlanTemplate,
  PresignedUpload,
  Product,
  ProductDetails,
  ProductVariant,
  ResolvedPayoutAccount,
  ResolvePayoutAccountInput,
  SetPayoutAccountInput,
  StorefrontCategory,
  UpdateMyStoreInput,
  UpdateProductInput,
  MerchantStatement,
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
    queryFn: async () => (await api.get<MerchantProfile>('/merchant/me')).data,
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
 * order status and is what an integrator uses; this one filters on the
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
 * knows none of it — and is what an integrator uses. This one carries the sale
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

/**
 * One month of the seller's account: opening and closing balance, what came in
 * and went out, and every ledger line in between. The same statement the CSV
 * and printable versions are rendered from.
 */
export function useMerchantStatement(period: StatementPeriod) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'statement', period.year, period.month],
    queryFn: async () =>
      (
        await api.get<MerchantStatement>('/merchant/statement', {
          params: { year: period.year, month: period.month },
        })
      ).data,
    // Stepping to the next month keeps the last one on screen until it lands,
    // rather than flashing an empty statement.
    placeholderData: (previous) => previous,
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

// --- The shopfront -----------------------------------------------------------

/**
 * The seller's own store.
 *
 * `retry: false` because the interesting failure is a 404: one merchant has at
 * most one store (`stores_merchant_id_key`), and a merchant who signed up
 * before the store could be provisioned has none. Shop setup branches on that,
 * so retrying it three times only delays the screen that handles it.
 */
export function useMerchantStore() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'store'],
    queryFn: async () => (await api.get<MerchantStore>('/merchant/store')).data,
    retry: false,
  });
}

/** True when the failure was "this merchant has no store", not a broken call. */
export function isNoStoreYet(error: unknown): boolean {
  return apiErrorStatus(error) === 404;
}

export function useUpdateMerchantStore() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateMyStoreInput) =>
      (await api.patch<MerchantStore>('/merchant/store', patch)).data,
    onSuccess: (store) => {
      // Written straight into the cache rather than invalidated: the shop
      // screen is a form bound to this object, and a refetch would blank the
      // fields for a frame while the seller is still looking at them.
      queryClient.setQueryData(['merchant', 'store'], store);
    },
  });
}

/**
 * The taxonomy a shop and its products are filed under.
 *
 * Top-level only. `stores.primary_category_id` has a foreign key that cannot
 * see `parent_id`, and the service refuses a child slug outright — a shop
 * listed under "Laptops" would be invisible to anyone browsing "Electronics".
 * Public, so this is the one call in the app that is not under `/merchant`.
 */
export function useShopCategories() {
  const api = useApi();
  return useQuery({
    queryKey: ['storefront', 'categories'],
    queryFn: async () =>
      (await api.get<StorefrontCategory[]>('/storefront/categories')).data.filter(
        (c) => c.parent_id === null,
      ),
    staleTime: 60 * 60_000,
  });
}

// --- Verification and payout --------------------------------------------------

export function useKycStatus() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'kyc'],
    queryFn: async () => (await api.get<MerchantKycStatus>('/merchant/kyc')).data,
  });
}

/** Banks and mobile-money wallets settlements can be sent to. */
export function usePayoutDestinations() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'payout-destinations'],
    queryFn: async () =>
      (await api.get<PayoutDestination[]>('/merchant/payout-account/destinations')).data,
    staleTime: 60 * 60_000,
  });
}

/**
 * Who the bank says owns an account, saving nothing.
 *
 * A separate step from setting it because the name is never sent by the client
 * — it is read back from the bank — and a seller should see "Kofi Mensah"
 * before they commit their payouts to a number they typed on a phone.
 */
export function useResolvePayoutAccount() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: SetPayoutAccountInput) =>
      (await api.post<ResolvedPayoutAccount>('/merchant/payout-account/resolve', input)).data,
  });
}

/**
 * Texts the seller's phone a code for replacing their payout account with this
 * one. A signed-in session alone could otherwise send every settlement
 * somewhere new; a first account needs no code.
 */
export function useSendPayoutChangeCode() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: ResolvePayoutAccountInput) =>
      (await api.post<PayoutChangeCodeSent>('/merchant/payout-account/code', input)).data,
  });
}

export function useSetPayoutAccount() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetPayoutAccountInput) =>
      (await api.post<Merchant>('/merchant/payout-account', input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'payout-account'] });
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'me'] });
    },
  });
}

// --- Photographs ---------------------------------------------------------------

/** What the phone knows about a picked image before it is uploaded. */
export interface PickedImage {
  uri: string;
  mimeType?: string | null;
  fileSize?: number | null;
}

/**
 * Puts an image in the bucket and hands back the key.
 *
 * Three steps, in this order and no other: the server mints a key it chose
 * (namespaced by the caller's own merchant id, so the route cannot be pointed
 * at another shop's folder), the phone PUTs the bytes straight to storage, and
 * the caller then attaches the key wherever it belongs. Image bytes never pass
 * through the API — and every endpoint that takes a key back checks it was
 * issued to this merchant, because a public product photo pointed at a
 * competitor's would render perfectly.
 */
export function useUploadImage() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: {
      image: PickedImage;
      purpose: 'product_image' | 'store_logo' | 'store_banner' | 'merchant_kyc_document';
    }): Promise<string> => {
      const contentType = input.image.mimeType ?? 'image/jpeg';
      const blob = await (await fetch(input.image.uri)).blob();

      const { data: presigned } = await api.post<PresignedUpload>('/merchant/uploads', {
        purpose: input.purpose,
        content_type: contentType,
        content_length: input.image.fileSize ?? blob.size,
      });

      const put = await fetch(presigned.url, {
        method: presigned.method,
        headers: presigned.headers,
        body: blob,
      });
      if (!put.ok) throw new Error(`The photo could not be uploaded (${put.status}).`);
      return presigned.key;
    },
  });
}

/** Sends a KYC document: the bytes first, then the key with what it is. */
export function useSubmitKycDocument() {
  const api = useApi();
  const queryClient = useQueryClient();
  const upload = useUploadImage();
  return useMutation({
    mutationFn: async (input: { image: PickedImage; docType: MerchantKycDocType }) => {
      const storage_key = await upload.mutateAsync({
        image: input.image,
        purpose: 'merchant_kyc_document',
      });
      return (
        await api.post<MerchantKycDocument>('/merchant/kyc/documents', {
          doc_type: input.docType,
          storage_key,
        })
      ).data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'kyc'] });
    },
  });
}

// --- Listing a product ----------------------------------------------------------

/**
 * The instalment plans a product may be sold on.
 *
 * The merchant's copy of the list, not the storefront's: this one is already
 * filtered to `is_active`, and it is the same set `PUT products/:id/plan-offers`
 * will accept. Every eligibility rule (`min_amount_pesewas`, category
 * exclusions) is the platform's, not the seller's, so the screen shows which
 * plans a price actually reaches rather than letting one be chosen and refused.
 */
export function usePlanTemplates() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'plan-templates'],
    queryFn: async () => (await api.get<PlanTemplate[]>('/merchant/plan-templates')).data,
    staleTime: 60 * 60_000,
  });
}

/**
 * Lists a product into the seller's own shop.
 *
 * One request, not four. `createProductSchema` takes the variants, the photo
 * keys and the plan offers with the product, and the service writes all of them
 * in a single transaction — so a listing cannot end up half-created with stock
 * but no photographs on a connection that dropped between calls.
 *
 * `store_id` is not sent: the controller fills it from the caller's own store.
 */
export function useCreateProduct() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateProductInput, 'store_id'>) =>
      (await api.post<ProductDetails>('/merchant/products', input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'catalog'] });
    },
  });
}

// --- Editing a listing ----------------------------------------------------------

/** One of the seller's own products, with its variants, photos and plan offers. */
export function useProduct(productId: string | undefined) {
  const api = useApi();
  return useQuery({
    enabled: Boolean(productId),
    queryKey: ['merchant', 'product', productId],
    queryFn: async () =>
      (await api.get<MerchantProductDetails>(`/merchant/products/${productId}`)).data,
  });
}

/**
 * Invalidates everything a catalogue write can move.
 *
 * The product itself, the list page it appears on, and the summary behind the
 * filter chips — a restock changes `outOfStockVariants`, and a chip still
 * saying "3" after the seller fixed the third one is the kind of stale number
 * that makes a seller stop trusting the screen.
 */
function useCatalogInvalidator(): (productId?: string) => void {
  const queryClient = useQueryClient();
  return (productId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['merchant', 'catalog'] });
    if (productId)
      void queryClient.invalidateQueries({ queryKey: ['merchant', 'product', productId] });
  };
}

export function useUpdateProduct(productId: string | undefined) {
  const api = useApi();
  const invalidate = useCatalogInvalidator();
  return useMutation({
    mutationFn: async (patch: UpdateProductInput) =>
      (await api.patch<Product>(`/merchant/products/${productId}`, patch)).data,
    onSuccess: () => invalidate(productId),
  });
}

export function useAddVariant(productId: string | undefined) {
  const api = useApi();
  const invalidate = useCatalogInvalidator();
  return useMutation({
    mutationFn: async (input: AddVariantInput) =>
      (await api.post<ProductVariant>(`/merchant/products/${productId}/variants`, input)).data,
    onSuccess: () => invalidate(productId),
  });
}

export function useAddProductImage(productId: string | undefined) {
  const api = useApi();
  const invalidate = useCatalogInvalidator();
  const upload = useUploadImage();
  return useMutation({
    mutationFn: async (image: PickedImage) => {
      const storage_key = await upload.mutateAsync({ image, purpose: 'product_image' });
      return (
        await api.post<MerchantProductImage>(`/merchant/products/${productId}/images`, {
          storage_key,
        })
      ).data;
    },
    onSuccess: () => invalidate(productId),
  });
}

export function useSetPlanOffers(productId: string | undefined) {
  const api = useApi();
  const invalidate = useCatalogInvalidator();
  return useMutation({
    mutationFn: async (planTemplateIds: string[]) =>
      (
        await api.put(`/merchant/products/${productId}/plan-offers`, {
          plan_template_ids: planTemplateIds,
        })
      ).data,
    onSuccess: () => invalidate(productId),
  });
}

/**
 * Sets what is on the shelf for one variant.
 *
 * `PUT`, not the `adjust` route: the restock sheet shows a count and saves that
 * count. A delta would be wrong the moment two devices are open on the same
 * shop, and it is not what the seller is looking at.
 *
 * `productId` is only for cache invalidation — the route is scoped by variant,
 * and by merchant in the service's WHERE clause.
 */
export function useSetStock(productId?: string) {
  const api = useApi();
  const invalidate = useCatalogInvalidator();
  return useMutation({
    mutationFn: async (input: { variantId: string; quantity: number }) =>
      (
        await api.put<Inventory>(`/merchant/variants/${input.variantId}/inventory`, {
          quantity_available: input.quantity,
        })
      ).data,
    onSuccess: () => invalidate(productId),
  });
}

// --- Returns ---------------------------------------------------------------------

/**
 * The returns queue.
 *
 * `/merchant/return-list`, not `/merchant/returns`. The latter answers with the
 * bare `order_returns` rows — an order id, a customer id and two amounts — and
 * a seller deciding on a return is deciding about a sale. This one carries the
 * order number, the buyer, what is coming back and what approving costs.
 */
export function useReturns(bucket: MerchantReturnBucket) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'return-list', bucket],
    queryFn: async () =>
      (
        await api.get<MerchantReturnPage>('/merchant/return-list', {
          params: { bucket, limit: 200 },
        })
      ).data,
  });
}

export function useReturnCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', 'return-list', 'counts'],
    queryFn: async () => (await api.get<MerchantReturnCounts>('/merchant/return-list/counts')).data,
  });
}

export function useReturn(returnId: string | undefined) {
  const api = useApi();
  return useQuery({
    enabled: Boolean(returnId),
    queryKey: ['merchant', 'return', returnId],
    queryFn: async () =>
      (await api.get<MerchantReturnDetail>(`/merchant/return-list/${returnId}`)).data,
  });
}

/**
 * Deciding a return.
 *
 * Approving is not a status change: it reverses the sale in the ledger,
 * restocks the goods and raises the buyer's refund, all in one transaction. So
 * everything the seller's money screens show is stale afterwards — the balance,
 * the payouts, the order and the catalogue counts all move — and all of them
 * are invalidated rather than just the return.
 *
 * Irreversible either way: a second decision is `ReturnAlreadyDecidedError`.
 */
export function useDecideReturn(returnId: string | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision: { approve: true } | { approve: false; note: string }) => {
      const path = `/merchant/returns/${returnId}/${decision.approve ? 'approve' : 'reject'}`;
      const body = decision.approve ? {} : { decision_note: decision.note };
      return (await api.post<OrderReturn>(path, body)).data;
    },
    onSuccess: () => {
      for (const key of [
        ['merchant', 'return-list'],
        ['merchant', 'return', returnId],
        ['merchant', 'balances'],
        ['merchant', 'payouts'],
        ['merchant', 'queue'],
        ['merchant', 'catalog'],
        ['merchant', 'stats'],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
