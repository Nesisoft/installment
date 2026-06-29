import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  ActivatedPlan,
  CustomerPlan,
  DefaultPlanInput,
  InstallmentScheduleRow,
  PlanSettlementView,
  RecordManualPaymentInput,
  RefundInstallmentInput,
} from '@installment/api-types';

export function usePlan(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan', id],
    queryFn: async () => {
      const { data } = await api.get<CustomerPlan>(`/admin/plans/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function usePlanSchedule(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-schedule', id],
    queryFn: async () => {
      const { data } = await api.get<InstallmentScheduleRow[]>(`/admin/plans/${id}/schedule`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function usePlanSettlement(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-settlement', id],
    queryFn: async () => {
      const { data } = await api.get<PlanSettlementView>(`/admin/plans/${id}/settlement`);
      return data;
    },
    enabled: Boolean(id),
  });
}

function usePlanActionInvalidator(planId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['plan', planId] });
    void qc.invalidateQueries({ queryKey: ['plan-schedule', planId] });
    void qc.invalidateQueries({ queryKey: ['plan-settlement', planId] });
  };
}

export function useRecordManualPayment(planId: string) {
  const api = useApi();
  const invalidate = usePlanActionInvalidator(planId);
  return useMutation({
    mutationFn: async (args: { scheduleId: string; input: RecordManualPaymentInput }) => {
      const { data } = await api.post(
        `/admin/installments/${args.scheduleId}/record-payment`,
        args.input,
      );
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useRefundInstallment(planId: string) {
  const api = useApi();
  const invalidate = usePlanActionInvalidator(planId);
  return useMutation({
    mutationFn: async (args: { scheduleId: string; input: RefundInstallmentInput }) => {
      const { data } = await api.post(`/admin/installments/${args.scheduleId}/refund`, args.input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDefaultPlan(planId: string) {
  const api = useApi();
  const invalidate = usePlanActionInvalidator(planId);
  return useMutation({
    mutationFn: async (input: DefaultPlanInput) => {
      const { data } = await api.post<CustomerPlan>(`/admin/plans/${planId}/default`, input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useActivateFromApplication() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (applicationId: string) => {
      const { data } = await api.post<ActivatedPlan>(
        `/admin/plans/from-application/${applicationId}`,
      );
      return data;
    },
    onSuccess: (_data, applicationId) => {
      void qc.invalidateQueries({ queryKey: ['application', applicationId] });
    },
  });
}
