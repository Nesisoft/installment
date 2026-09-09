import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '@installment/mobile-kit';
import type {
  CreateReviewInput,
  ProductReviewView,
  ReviewablePurchase,
} from '@installment/api-types';

/**
 * Rating something you actually received.
 *
 * `POST /me/reviews` and `GET /me/reviews/pending` had no caller anywhere in
 * the monorepo, while `rating_avg` and `rating_count` render on the product
 * screen, on every product card and in the vendor header — and the product
 * screen fetches the review list. So the list was permanently empty and every
 * rating permanently null, on four surfaces, with nothing broken to find.
 */

export function usePendingReviews(enabled = true): UseQueryResult<ReviewablePurchase[]> {
  const api = useApi();
  return useQuery({
    queryKey: ['reviews-pending'],
    queryFn: async () => (await api.get<ReviewablePurchase[]>('/me/reviews/pending')).data,
    enabled,
  });
}

export function useCreateReview() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReviewInput) =>
      (await api.post<ProductReviewView>('/me/reviews', input)).data,
    onSuccess: (review) => {
      // The line leaves the pending queue.
      void qc.invalidateQueries({ queryKey: ['reviews-pending'] });
      // And the product's own list and average change, both of which are
      // correlated subqueries computed at read time — so a refetch is all it
      // takes for the new rating to appear everywhere it is shown.
      void qc.invalidateQueries({ queryKey: ['product-reviews', review.product_id] });
      void qc.invalidateQueries({ queryKey: ['product', review.product_id] });
    },
  });
}
