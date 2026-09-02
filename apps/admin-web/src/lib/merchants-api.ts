import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AttachPaystackRecipientInput,
  CreateMerchantInput,
  ListMerchantsParams,
  Merchant,
  MerchantBalances,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  Store,
  TransitionMerchantInput,
  TransitionStoreInput,
} from '@installment/api-types';

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

export function useMerchant(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['merchant', id],
    queryFn: async () => {
      const { data } = await api.get<Merchant>(`/admin/merchants/${id}`);
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
