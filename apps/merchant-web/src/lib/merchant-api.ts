import { useQuery } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  CustomerPlan,
  InstallmentScheduleRow,
  Merchant,
  MerchantBalances,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  MerchantStatement,
  PlanSettlementView,
  PlanTemplate,
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
