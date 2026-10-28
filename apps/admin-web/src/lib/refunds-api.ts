import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  DisburseResult,
  ListRefundsParams,
  Refund,
  RefundListRow,
  RefundQueueTotal,
  SettleRefundManuallyInput,
} from '@installment/api-types';

export function useRefunds(params: ListRefundsParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['refunds', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: RefundListRow[]; total: number }>('/admin/refunds', {
        params,
      });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useRefundSummary() {
  const api = useApi();
  return useQuery({
    queryKey: ['refund-summary'],
    queryFn: async () => {
      const { data } = await api.get<RefundQueueTotal[]>('/admin/refunds/summary');
      return data;
    },
    refetchInterval: 60_000,
  });
}

/** What is owed back on one plan, and where each refund stands. */
export function usePlanRefunds(planId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-refunds', planId],
    queryFn: async () => {
      const { data } = await api.get<Refund[]>(`/admin/refunds/plan/${planId}`);
      return data;
    },
    enabled: Boolean(planId),
  });
}

function useRefundInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['refunds'] });
    void qc.invalidateQueries({ queryKey: ['refund-summary'] });
    void qc.invalidateQueries({ queryKey: ['plan-refunds'] });
  };
}

/**
 * The caller supplies the Idempotency-Key, minted once per attempt and reused
 * if that attempt is retried: the server hashes the body, so a fresh key per
 * press would make a retried press a second request.
 */
export function useSendRefund() {
  const api = useApi();
  const invalidate = useRefundInvalidator();
  return useMutation({
    mutationFn: async (args: { reference: string; idempotencyKey: string }) => {
      const { data } = await api.post<DisburseResult>(
        `/admin/refunds/${encodeURIComponent(args.reference)}/send`,
        undefined,
        { headers: { 'Idempotency-Key': args.idempotencyKey } },
      );
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useMarkRefundPaid() {
  const api = useApi();
  const invalidate = useRefundInvalidator();
  return useMutation({
    mutationFn: async (args: {
      reference: string;
      input: SettleRefundManuallyInput;
      idempotencyKey: string;
    }) => {
      const { data } = await api.post<Refund>(
        `/admin/refunds/${encodeURIComponent(args.reference)}/settle-manual`,
        args.input,
        { headers: { 'Idempotency-Key': args.idempotencyKey } },
      );
      return data;
    },
    onSuccess: invalidate,
  });
}
