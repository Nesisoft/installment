import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AdminOrderCounts,
  AdminOrderDetail,
  AdminOrderRow,
  ListAdminOrdersParams,
  Order,
} from '@installment/api-types';

export function useAdminOrders(params: ListAdminOrdersParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-orders', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: AdminOrderRow[]; total: number }>('/admin/orders', {
        params,
      });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useAdminOrderCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-order-counts'],
    queryFn: async () => {
      const { data } = await api.get<AdminOrderCounts>('/admin/orders/counts');
      return data;
    },
    refetchInterval: 60_000,
  });
}

export function useAdminOrder(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-order', id],
    queryFn: async () => {
      const { data } = await api.get<AdminOrderDetail>(`/admin/orders/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

function useOrderInvalidator(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin-order', id] });
    void qc.invalidateQueries({ queryKey: ['admin-orders'] });
    void qc.invalidateQueries({ queryKey: ['admin-order-counts'] });
  };
}

/** Books the payment: cash in, the seller's payable, the commission. */
export function useConfirmOrderPayment(id: string) {
  const api = useApi();
  const invalidate = useOrderInvalidator(id);
  return useMutation({
    mutationFn: async (args: { providerReference: string; idempotencyKey: string }) => {
      const { data } = await api.post<Order>(
        `/admin/orders/${id}/confirm-payment`,
        { provider_reference: args.providerReference },
        { headers: { 'Idempotency-Key': args.idempotencyKey } },
      );
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useCancelOrder(id: string) {
  const api = useApi();
  const invalidate = useOrderInvalidator(id);
  return useMutation({
    mutationFn: async (reason: string | undefined) => {
      const { data } = await api.post<Order>(
        `/admin/orders/${id}/cancel`,
        reason ? { reason } : {},
      );
      return data;
    },
    onSuccess: invalidate,
  });
}
