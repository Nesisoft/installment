import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  CreatePlanTemplateInput,
  ListPlanTemplatesParams,
  PlanTemplate,
  UpdatePlanTemplateInput,
} from '@installment/api-types';

export function usePlanTemplates(params: ListPlanTemplatesParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-templates', params],
    queryFn: async () => {
      const { data } = await api.get<PlanTemplate[]>('/admin/plan-templates', { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function usePlanTemplate(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-template', id],
    queryFn: async () => {
      const { data } = await api.get<PlanTemplate>(`/admin/plan-templates/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useCreatePlanTemplate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePlanTemplateInput) => {
      const { data } = await api.post<PlanTemplate>('/admin/plan-templates', input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plan-templates'] }),
  });
}

export function useUpdatePlanTemplate(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePlanTemplateInput) => {
      const { data } = await api.patch<PlanTemplate>(`/admin/plan-templates/${id}`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan-template', id] });
      void qc.invalidateQueries({ queryKey: ['plan-templates'] });
    },
  });
}

export function useSetPlanTemplateActive(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (active: boolean) => {
      const action = active ? 'activate' : 'deactivate';
      const { data } = await api.post<PlanTemplate>(`/admin/plan-templates/${id}/${action}`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan-template', id] });
      void qc.invalidateQueries({ queryKey: ['plan-templates'] });
    },
  });
}
