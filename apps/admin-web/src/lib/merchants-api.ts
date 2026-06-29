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
  TransitionMerchantInput,
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
