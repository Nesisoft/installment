import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import type {
  ChargeResult,
  CreditStanding,
  CustomerPlan,
  CustomerProfile,
  FeedInstallment,
  GhanaCardStatusView,
  InstallmentRow,
  MomoProvider,
  PresignedUpload,
  StorefrontProduct,
} from './types';

// --- Profile & credit ---------------------------------------------------------

export function useProfile(enabled = true): UseQueryResult<CustomerProfile> {
  const api = useApi();
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await api.get<CustomerProfile>('/me/profile')).data,
    enabled,
  });
}

export function useCredit(enabled = true): UseQueryResult<CreditStanding> {
  const api = useApi();
  return useQuery({
    queryKey: ['credit'],
    queryFn: async () => (await api.get<CreditStanding>('/me/credit')).data,
    enabled,
  });
}

export function useSetMomo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { momo_phone: string; momo_provider: MomoProvider }) =>
      (await api.post('/me/momo', input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profile'] }),
  });
}

export function useUpdateProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { first_name?: string; last_name?: string; email?: string }) =>
      (await api.patch('/me/profile', patch)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profile'] }),
  });
}

// --- Instalments --------------------------------------------------------------

export type InstallmentFilter = 'all' | 'due' | 'upcoming' | 'paid' | 'overdue';

export function useInstallments(
  status: InstallmentFilter = 'all',
  enabled = true,
): UseQueryResult<FeedInstallment[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['installments', status],
    queryFn: async () =>
      (await api.get<FeedInstallment[]>('/me/installments', { params: { status } })).data,
    enabled,
  });
}

/** The one thing owed next — the home screen's due strip. */
export function useNextInstallment(enabled = true): UseQueryResult<FeedInstallment | null> {
  const api = useApi();
  return useQuery({
    queryKey: ['installments', 'next'],
    queryFn: async () =>
      (await api.get<{ installment: FeedInstallment | null }>('/me/installments/next')).data
        .installment,
    enabled,
  });
}

export function usePlans(enabled = true): UseQueryResult<CustomerPlan[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['plans'],
    queryFn: async () => (await api.get<CustomerPlan[]>('/me/plans')).data,
    enabled,
  });
}

export function usePlanSchedule(planId: string): UseQueryResult<InstallmentRow[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-schedule', planId],
    queryFn: async () => (await api.get<InstallmentRow[]>(`/me/plans/${planId}/schedule`)).data,
    enabled: Boolean(planId),
  });
}

/**
 * Turn automatic collection on or off.
 *
 * Optimistic, because a toggle that waits for a round trip on a mobile network
 * feels broken — and rolled back on failure, because a switch that lies about
 * whether we will debit someone is worse than a slow one.
 */
export function useSetAutopay() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, enabled }: { planId: string; enabled: boolean }) =>
      (await api.post<CustomerPlan>(`/me/plans/${planId}/autopay`, { enabled })).data,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['installments'] });
    },
  });
}

/**
 * Pay an instalment by Mobile Money.
 *
 * The key is the caller's, for the same reason as checkout: a customer who
 * leaves for the MoMo dialler, comes back to a spinner and taps again must not
 * be debited twice. A 409 here means "a charge is already in flight", which the
 * UI shows as progress, not as an error.
 */
export function usePayInstallmentMomo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      scheduleId: string;
      phone?: string;
      provider?: MomoProvider;
      idempotencyKey: string;
    }) => {
      const { scheduleId, idempotencyKey, ...body } = args;
      return (
        await api.post<ChargeResult>(`/me/installments/${scheduleId}/pay-momo`, body, {
          headers: { 'Idempotency-Key': idempotencyKey },
        })
      ).data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['installments'] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['plan-schedule'] });
      void qc.invalidateQueries({ queryKey: ['credit'] });
    },
  });
}

/** A hosted Paystack page for paying an instalment by card. */
export function usePayInstallmentLink() {
  const api = useApi();
  return useMutation({
    mutationFn: async (scheduleId: string) =>
      (
        await api.post<{ url: string; reference: string }>(
          `/me/installments/${scheduleId}/pay-link`,
          {},
        )
      ).data,
  });
}

// --- Saved items ---------------------------------------------------------------

export function useWishlist(enabled = true): UseQueryResult<StorefrontProduct[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['wishlist'],
    queryFn: async () => (await api.get<StorefrontProduct[]>('/me/wishlist')).data,
    enabled,
  });
}

/** Just the ids — what a product grid needs to fill in its hearts. */
export function useWishlistIds(enabled = true): UseQueryResult<string[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['wishlist', 'ids'],
    queryFn: async () => (await api.get<string[]>('/me/wishlist/ids')).data,
    enabled,
  });
}

export function useToggleWishlist() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, saved }: { productId: string; saved: boolean }) => {
      if (saved) await api.delete(`/me/wishlist/${productId}`);
      else await api.post('/me/wishlist', { product_id: productId });
      return !saved;
    },
    // Optimistic: a heart that waits for the network reads as a dead button.
    onMutate: async ({ productId, saved }) => {
      await qc.cancelQueries({ queryKey: ['wishlist', 'ids'] });
      const previous = qc.getQueryData<string[]>(['wishlist', 'ids']) ?? [];
      qc.setQueryData<string[]>(
        ['wishlist', 'ids'],
        saved ? previous.filter((id) => id !== productId) : [...previous, productId],
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(['wishlist', 'ids'], context.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['wishlist'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

// --- Ghana Card ---------------------------------------------------------------

export function useGhanaCard(enabled = true): UseQueryResult<GhanaCardStatusView> {
  const api = useApi();
  return useQuery({
    queryKey: ['ghana-card'],
    queryFn: async () => (await api.get<GhanaCardStatusView>('/me/ghana-card')).data,
    enabled,
  });
}

/**
 * Sends a photo of the card, then the card itself.
 *
 * Three steps, and they have to be in this order: the server mints a key it
 * chose (namespaced by the caller's own customer id, so the route cannot be
 * pointed at anyone else's folder), the phone PUTs the bytes straight to
 * storage, and only then is the key attached. Nothing here ever posts an image
 * through the API.
 */
export function useSubmitGhanaCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      cardNumber: string;
      image: { uri: string; mimeType?: string | null; fileSize?: number | null };
    }): Promise<GhanaCardStatusView> => {
      const contentType = input.image.mimeType ?? 'image/jpeg';
      const blob = await (await fetch(input.image.uri)).blob();

      const { data: presigned } = await api.post<PresignedUpload>('/me/uploads', {
        purpose: 'kyc_document',
        content_type: contentType,
        content_length: input.image.fileSize ?? blob.size,
      });

      const put = await fetch(presigned.url, {
        method: presigned.method,
        headers: presigned.headers,
        body: blob,
      });
      if (!put.ok) throw new Error(`The photo could not be uploaded (${put.status}).`);

      const { data } = await api.post<GhanaCardStatusView>('/me/ghana-card', {
        ghana_card_number: input.cardNumber,
        ghana_card_image_key: presigned.key,
      });
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['ghana-card'], data);
      // The tier moved, and the profile screen shows it.
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
