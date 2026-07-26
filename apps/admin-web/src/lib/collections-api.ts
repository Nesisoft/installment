import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AssignCaseInput,
  CloseCaseInput,
  CollectionsAction,
  CollectionsCase,
  CollectionsCaseDetail,
  ListCasesParams,
  RecordActionInput,
} from '@installment/api-types';

export function useCollectionsCases(params: ListCasesParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['collections-cases', params],
    queryFn: async () => {
      const { data } = await api.get<CollectionsCase[]>('/admin/collections/cases', { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useCollectionsCase(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['collections-case', id],
    queryFn: async () => {
      const { data } = await api.get<CollectionsCaseDetail>(`/admin/collections/cases/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

function useCaseMutation<TInput, TResult>(
  id: string,
  fn: (api: ReturnType<typeof useApi>, input: TInput) => Promise<TResult>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(api, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['collections-case', id] });
      void qc.invalidateQueries({ queryKey: ['collections-cases'] });
    },
  });
}

export function useAssignCase(id: string) {
  return useCaseMutation<AssignCaseInput, CollectionsCase>(id, async (api, input) => {
    const { data } = await api.post<CollectionsCase>(
      `/admin/collections/cases/${id}/assign`,
      input,
    );
    return data;
  });
}

export function useRecordCaseAction(id: string) {
  return useCaseMutation<RecordActionInput, CollectionsAction>(id, async (api, input) => {
    const { data } = await api.post<CollectionsAction>(
      `/admin/collections/cases/${id}/actions`,
      input,
    );
    return data;
  });
}

export function useCloseCase(id: string) {
  return useCaseMutation<CloseCaseInput, CollectionsCase>(id, async (api, input) => {
    const { data } = await api.post<CollectionsCase>(`/admin/collections/cases/${id}/close`, input);
    return data;
  });
}
