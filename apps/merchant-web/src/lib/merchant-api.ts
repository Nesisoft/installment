import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  CustomerPlan,
  InstallmentScheduleRow,
  MarkDeliveredInput,
  MarkOutForDeliveryInput,
  MarkShippedInput,
  Merchant,
  MerchantBalances,
  MerchantHeldReserveRow,
  MerchantPayoutsPage,
  MerchantStatement,
  Order,
  OrderWithItems,
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
