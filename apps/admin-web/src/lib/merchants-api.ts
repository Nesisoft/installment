import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AttachPaystackRecipientInput,
  CreateMerchantInput,
  MerchantKycStatus,
  ListMerchantsParams,
  Merchant,
  MerchantBalances,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  MerchantProfile,
  SellersOwing,
  Store,
  TransitionMerchantInput,
  TransitionStoreInput,
  UpdateMerchantInput,
} from '@installment/api-types';

// Re-exported so the pages import their view models from one place.
export type { MerchantKycDocument, MerchantKycStatus } from '@installment/api-types';

export function useMerchants(params: ListMerchantsParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchants', params],
    queryFn: async () => {
      const { data } = await api.get<Merchant[]>('/admin/merchants', { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

/**
 * Sellers whose payable has gone negative — owing Ejua, usually after returns.
 * The ones nothing will be paid to again come first.
 */
export function useSellersOwing() {
  const api = useApi();
  return useQuery({
    queryKey: ['settlements', 'sellers-owing'],
    queryFn: async () => (await api.get<SellersOwing>('/admin/settlements/sellers-owing')).data,
  });
}

export function useMerchant(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', id],
    queryFn: async () => {
      const { data } = await api.get<MerchantProfile>(`/admin/merchants/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useMerchantBalances(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant-balances', id],
    queryFn: async () => {
      const { data } = await api.get<MerchantBalances>(`/admin/merchants/${id}/balances`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useMerchantPayouts(id: string, params: { limit?: number; offset?: number } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant-payouts', id, params],
    queryFn: async () => {
      const { data } = await api.get<MerchantPayoutsPage>(`/admin/merchants/${id}/payouts`, {
        params,
      });
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useMerchantReserves(id: string, open = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant-reserves', id, open],
    queryFn: async () => {
      const { data } = await api.get<MerchantHeldReserveRow[]>(`/admin/merchants/${id}/reserves`, {
        params: { open },
      });
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useCreateMerchant() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateMerchantInput) => {
      const { data } = await api.post<Merchant>('/admin/merchants', input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['merchants'] }),
  });
}

/**
 * Sets or clears a merchant's negotiated rates. NULL ends a deal: plans
 * activated afterwards charge their business model's own rate again.
 */
export function useUpdateMerchantTerms(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Pick<
        UpdateMerchantInput,
        'mdr_bps_override' | 'reserve_bps_override' | 'commission_bps_override'
      >,
    ) => {
      const { data } = await api.patch<Merchant>(`/admin/merchants/${id}`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merchant', id] });
      void qc.invalidateQueries({ queryKey: ['merchants'] });
    },
  });
}

export function useTransitionMerchant(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransitionMerchantInput) => {
      const { data } = await api.post<Merchant>(`/admin/merchants/${id}/transition`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merchant', id] });
      void qc.invalidateQueries({ queryKey: ['merchants'] });
    },
  });
}

export function useAttachPaystackRecipient(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AttachPaystackRecipientInput) => {
      const { data } = await api.post<Merchant>(`/admin/merchants/${id}/paystack-recipient`, input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['merchant', id] }),
  });
}

// --- KYC review ------------------------------------------------------------
//
// A merchant leaving `pending_kyc` used to be a button with nothing behind it:
// the Ghana Card columns are on `customers`, and the `kyc_document` upload
// purpose belongs to a customer, so there was no document for a reviewer to
// look at. `POST :id/transition {activate}` now refuses until the required
// types are approved, which makes this card the thing that unblocks a merchant.

export function useMerchantKyc(merchantId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', merchantId, 'kyc'],
    queryFn: async () =>
      (await api.get<MerchantKycStatus>(`/admin/merchants/${merchantId}/kyc`)).data,
    enabled: Boolean(merchantId),
  });
}

/**
 * The document itself, behind a signed URL the API mints on request.
 *
 * Asked for rather than cached: the link lives about two minutes, and a Ghana
 * Card is personal data under Act 843 — every viewing should be a request the
 * console made on purpose.
 */
export function useMerchantKycScan(merchantId: string, documentId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', merchantId, 'kyc', documentId, 'scan'],
    queryFn: async () =>
      (
        await api.get<{ url: string; expires_at: string }>(
          `/admin/uploads/merchants/${merchantId}/kyc/${documentId}`,
        )
      ).data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

function useKycDecision(merchantId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentId: string; reason?: string }) => {
      const path = input.reason === undefined ? 'approve' : 'reject';
      const { data } = await api.post<{ status: MerchantKycStatus }>(
        `/admin/merchants/${merchantId}/kyc/${input.documentId}/${path}`,
        input.reason === undefined ? undefined : { reason: input.reason },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merchant', merchantId, 'kyc'] });
      // The activation gate reads the same rows, so the merchant card above
      // has to re-render too.
      void qc.invalidateQueries({ queryKey: ['merchant', merchantId] });
    },
  });
}

export function useReviewMerchantKyc(merchantId: string) {
  return useKycDecision(merchantId);
}

// --- The merchant's shopfront ----------------------------------------------
//
// A merchant and their store are separate rows with separate lifecycles, and
// both must be `active` before anything can be sold — since the seller-liveness
// fix, the storefront and checkout each check both. Self-signup creates the
// store as `draft`, so an admin reviewing a new merchant has to open the shop
// as well as activate the business. There was no way to do either from here.

export function useMerchantStore(merchantId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant-store', merchantId],
    queryFn: async () => {
      const { data } = await api.get<Store[]>('/admin/stores', {
        params: { merchant_id: merchantId, limit: 1 },
      });
      // One store per merchant — `stores_merchant_id_key` says so — but a
      // merchant whose signup half-failed has none, and that is a real state
      // this screen should show rather than crash on.
      return data[0] ?? null;
    },
    enabled: Boolean(merchantId),
  });
}

export function useTransitionStore(storeId: string, merchantId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransitionStoreInput) => {
      const { data } = await api.post<Store>(`/admin/stores/${storeId}/transition`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merchant-store', merchantId] });
    },
  });
}
