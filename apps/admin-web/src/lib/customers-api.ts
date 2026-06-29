import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AttachGhanaCardInput,
  Customer,
  ListCustomersParams,
  RecordConsentInput,
  RegisterCustomerInput,
  SetBlocklistInput,
  SetMomoInput,
  UpdateCustomerInput,
} from '@installment/api-types';

export function useCustomers(params: ListCustomersParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['customers', params],
    queryFn: async () => {
      const { data } = await api.get<Customer[]>('/admin/customers', { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useCustomer(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['customer', id],
    queryFn: async () => {
      const { data } = await api.get<Customer>(`/admin/customers/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useRegisterCustomer() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RegisterCustomerInput) => {
      const { data } = await api.post<Customer>('/admin/customers', input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });
}

/** Hooks that mutate a single customer; all invalidate that customer + the list. */
function useCustomerMutation<TInput>(
  id: string,
  fn: (api: ReturnType<typeof useApi>, input: TInput) => Promise<Customer>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(api, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', id] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useUpdateCustomer(id: string) {
  return useCustomerMutation<UpdateCustomerInput>(id, async (api, input) => {
    const { data } = await api.patch<Customer>(`/admin/customers/${id}`, input);
    return data;
  });
}

export function useAttachGhanaCard(id: string) {
  return useCustomerMutation<AttachGhanaCardInput>(id, async (api, input) => {
    const { data } = await api.post<Customer>(`/admin/customers/${id}/ghana-card`, input);
    return data;
  });
}

export function useVerifyGhanaCard(id: string) {
  return useCustomerMutation<void>(id, async (api) => {
    const { data } = await api.post<Customer>(`/admin/customers/${id}/ghana-card/verify`);
    return data;
  });
}

export function useSetMomo(id: string) {
  return useCustomerMutation<SetMomoInput>(id, async (api, input) => {
    const { data } = await api.post<Customer>(`/admin/customers/${id}/momo`, input);
    return data;
  });
}

export function useRecordConsent(id: string) {
  return useCustomerMutation<RecordConsentInput>(id, async (api, input) => {
    const { data } = await api.post<Customer>(`/admin/customers/${id}/consent`, input);
    return data;
  });
}

export function useSetBlocklist(id: string) {
  return useCustomerMutation<SetBlocklistInput>(id, async (api, input) => {
    const { data } = await api.post<Customer>(`/admin/customers/${id}/blocklist`, input);
    return data;
  });
}

export function useRemoveBlocklist(id: string) {
  return useCustomerMutation<void>(id, async (api) => {
    const { data } = await api.delete<Customer>(`/admin/customers/${id}/blocklist`);
    return data;
  });
}
