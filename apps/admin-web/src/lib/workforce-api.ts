import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  CreateEmployerInput,
  CreateStaffInput,
  CustomerEmployment,
  Employer,
  EmployerCounts,
  EmployerSummary,
  EmploymentRow,
  LinkEmploymentInput,
  ListEmployerSummaryParams,
  ListEmploymentParams,
  RecordPayrollConsentInput,
  ResetStaffPasswordInput,
  SetUserActiveInput,
  StaffMember,
  StaffRole,
  TransitionEmployerInput,
  TransitionEmploymentInput,
  UnverifyEmploymentInput,
  UpdateEmployerInput,
  VerifyEmploymentInput,
} from '@installment/api-types';

// --- Employers ----------------------------------------------------------------

export function useEmployerSummary(params: ListEmployerSummaryParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['employer-summary', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: EmployerSummary[]; total: number }>(
        '/admin/employers/summary',
        { params },
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useEmployerCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['employer-counts'],
    queryFn: async () => {
      const { data } = await api.get<EmployerCounts>('/admin/employers/counts');
      return data;
    },
  });
}

export function useEmployer(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['employer', id],
    queryFn: async () => {
      const { data } = await api.get<Employer>(`/admin/employers/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

function useEmployerInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['employer'] });
    void qc.invalidateQueries({ queryKey: ['employer-summary'] });
    void qc.invalidateQueries({ queryKey: ['employer-counts'] });
  };
}

export function useCreateEmployer() {
  const api = useApi();
  const invalidate = useEmployerInvalidator();
  return useMutation({
    mutationFn: async (input: CreateEmployerInput) => {
      const { data } = await api.post<Employer>('/admin/employers', input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateEmployer(id: string) {
  const api = useApi();
  const invalidate = useEmployerInvalidator();
  return useMutation({
    mutationFn: async (input: UpdateEmployerInput) => {
      const { data } = await api.patch<Employer>(`/admin/employers/${id}`, input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useTransitionEmployer(id: string) {
  const api = useApi();
  const invalidate = useEmployerInvalidator();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransitionEmployerInput) => {
      const { data } = await api.post<Employer>(`/admin/employers/${id}/transition`, input);
      return data;
    },
    onSuccess: () => {
      invalidate();
      // A link's standing depends on its employer's.
      void qc.invalidateQueries({ queryKey: ['employment'] });
    },
  });
}

// --- Employment links ---------------------------------------------------------

export function useEmployment(params: ListEmploymentParams, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['employment', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: EmploymentRow[]; total: number }>(
        '/admin/employers/employment',
        { params },
      );
      return data;
    },
    enabled,
    placeholderData: (prev) => prev,
  });
}

function useEmploymentInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['employment'] });
    void qc.invalidateQueries({ queryKey: ['employer-summary'] });
  };
}

export function useLinkEmployment() {
  const api = useApi();
  const invalidate = useEmploymentInvalidator();
  return useMutation({
    mutationFn: async (input: LinkEmploymentInput) => {
      const { data } = await api.post<CustomerEmployment>('/admin/employers/employment', input);
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Every change to one link, so a row can offer them all from one hook. */
export function useEmploymentActions(id: string) {
  const api = useApi();
  const invalidate = useEmploymentInvalidator();
  const post = (path: string) => async (body: unknown) => {
    const { data } = await api.post<CustomerEmployment>(
      `/admin/employers/employment/${id}/${path}`,
      body,
    );
    return data;
  };
  return {
    verify: useMutation({
      mutationFn: post('verify') as (input: VerifyEmploymentInput) => Promise<CustomerEmployment>,
      onSuccess: invalidate,
    }),
    unverify: useMutation({
      mutationFn: post('unverify') as (
        input: UnverifyEmploymentInput,
      ) => Promise<CustomerEmployment>,
      onSuccess: invalidate,
    }),
    consent: useMutation({
      mutationFn: post('consent') as (
        input: RecordPayrollConsentInput,
      ) => Promise<CustomerEmployment>,
      onSuccess: invalidate,
    }),
    transition: useMutation({
      mutationFn: post('transition') as (
        input: TransitionEmploymentInput,
      ) => Promise<CustomerEmployment>,
      onSuccess: invalidate,
    }),
  };
}

// --- Staff --------------------------------------------------------------------

export function useStaff() {
  const api = useApi();
  return useQuery({
    queryKey: ['staff'],
    queryFn: async () => {
      const { data } = await api.get<StaffMember[]>('/admin/users/staff');
      return data;
    },
  });
}

export function useStaffRoles() {
  const api = useApi();
  return useQuery({
    queryKey: ['staff-roles'],
    queryFn: async () => {
      const { data } = await api.get<StaffRole[]>('/admin/users/roles');
      return data;
    },
  });
}

function useStaffInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['staff'] });
    void qc.invalidateQueries({ queryKey: ['staff-roles'] });
  };
}

export function useCreateStaff() {
  const api = useApi();
  const invalidate = useStaffInvalidator();
  return useMutation({
    mutationFn: async (input: CreateStaffInput) => {
      const { data } = await api.post<StaffMember>('/admin/users/staff', input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useStaffActions(userId: string) {
  const api = useApi();
  const invalidate = useStaffInvalidator();
  const role = (r: string) => `/admin/users/${userId}/roles/${encodeURIComponent(r)}`;
  return {
    grant: useMutation({
      mutationFn: async (roleName: string) => {
        await api.post(role(roleName));
      },
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: async (roleName: string) => {
        await api.delete(role(roleName));
      },
      onSuccess: invalidate,
    }),
    setActive: useMutation({
      mutationFn: async (args: { active: boolean } & SetUserActiveInput) => {
        await api.post(`/admin/users/${userId}/${args.active ? 'reactivate' : 'deactivate'}`, {
          reason: args.reason,
        });
      },
      onSuccess: invalidate,
    }),
    resetPassword: useMutation({
      mutationFn: async (input: ResetStaffPasswordInput) => {
        await api.post(`/admin/users/${userId}/password`, input);
      },
      onSuccess: invalidate,
    }),
  };
}
