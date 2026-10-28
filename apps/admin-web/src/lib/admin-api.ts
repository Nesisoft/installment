import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  Application,
  CreditProfile,
  LedgerIntegrityReport,
  ListApplicationsParams,
  RecordDecisionInput,
  ScoreResult,
  ScoringDecision,
  TelcoHealth,
} from '@installment/api-types';

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    return (err as { response?: { status?: number } }).response?.status;
  }
  return undefined;
}

export function useApplications(params: ListApplicationsParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['applications', params],
    queryFn: async () => {
      const { data } = await api.get<Application[]>('/admin/applications', { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useApplication(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['application', id],
    queryFn: async () => {
      const { data } = await api.get<Application>(`/admin/applications/${id}`);
      return data;
    },
  });
}

/** Latest persisted decision; null when the application has not been scored yet. */
export function useLatestDecision(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['application-decision', id],
    queryFn: async (): Promise<CreditProfile | null> => {
      try {
        const { data } = await api.get<CreditProfile>(`/admin/applications/${id}/decision`);
        return data;
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
  });
}

export function useTelcoHealth() {
  const api = useApi();
  return useQuery({
    queryKey: ['telco-health'],
    queryFn: async () => {
      const { data } = await api.get<TelcoHealth[]>('/admin/telco-health');
      return data;
    },
    refetchInterval: 30_000,
  });
}

export function useDryRun(id: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<ScoringDecision>(`/admin/applications/${id}/score/dry-run`);
      return data;
    },
  });
}

export function useScoreApplication(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<ScoreResult>(`/admin/applications/${id}/score`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['application', id] });
      void qc.invalidateQueries({ queryKey: ['application-decision', id] });
      void qc.invalidateQueries({ queryKey: ['applications'] });
    },
  });
}

export function useRecordDecision(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordDecisionInput) => {
      const { data } = await api.post<Application>(`/admin/applications/${id}/decision`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['application', id] });
      void qc.invalidateQueries({ queryKey: ['applications'] });
    },
  });
}

/** Whether the books still balance. The hourly cron alerts on drift; this shows it. */
export function useLedgerIntegrity() {
  const api = useApi();
  return useQuery({
    queryKey: ['ledger-integrity'],
    queryFn: async () => {
      const { data } = await api.get<LedgerIntegrityReport>('/admin/ledger/integrity');
      return data;
    },
    refetchInterval: 5 * 60_000,
  });
}
