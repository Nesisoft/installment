import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@installment/web-kit';
import type {
  AdminProductCounts,
  AdminProductDetail,
  AdminProductRow,
  AdminStoreCounts,
  AdminStoreRow,
  Category,
  CreateCategoryInput,
  ListAdminProductsParams,
  ListAdminStoresParams,
  Product,
  Store,
  TakeDownProductInput,
  TransitionStoreInput,
  UpdateCategoryInput,
} from '@installment/api-types';

// --- Listings -----------------------------------------------------------------

export function useAdminProducts(params: ListAdminProductsParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-products', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: AdminProductRow[]; total: number }>(
        '/admin/catalogue/products',
        { params },
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useAdminProductCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-product-counts'],
    queryFn: async () => {
      const { data } = await api.get<AdminProductCounts>('/admin/catalogue/products/counts');
      return data;
    },
  });
}

export function useAdminProduct(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-product', id],
    queryFn: async () => {
      const { data } = await api.get<AdminProductDetail>(`/admin/catalogue/products/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

function useProductInvalidator(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin-product', id] });
    void qc.invalidateQueries({ queryKey: ['admin-products'] });
    void qc.invalidateQueries({ queryKey: ['admin-product-counts'] });
  };
}

export function useTakeDownProduct(id: string) {
  const api = useApi();
  const invalidate = useProductInvalidator(id);
  return useMutation({
    mutationFn: async (input: TakeDownProductInput) => {
      const { data } = await api.post<Product>(`/admin/products/${id}/take-down`, input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useLiftTakedown(id: string) {
  const api = useApi();
  const invalidate = useProductInvalidator(id);
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<Product>(`/admin/products/${id}/lift-takedown`);
      return data;
    },
    onSuccess: invalidate,
  });
}

// --- Shops --------------------------------------------------------------------

export function useAdminStores(params: ListAdminStoresParams) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-stores', params],
    queryFn: async () => {
      const { data } = await api.get<{ rows: AdminStoreRow[]; total: number }>(
        '/admin/catalogue/stores',
        { params },
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useAdminStoreCounts() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-store-counts'],
    queryFn: async () => {
      const { data } = await api.get<AdminStoreCounts>('/admin/catalogue/stores/counts');
      return data;
    },
  });
}

/** Open, suspend or reopen a shop from the shops list. */
export function useTransitionAnyStore() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { storeId: string; input: TransitionStoreInput }) => {
      const { data } = await api.post<Store>(
        `/admin/stores/${args.storeId}/transition`,
        args.input,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-stores'] });
      void qc.invalidateQueries({ queryKey: ['admin-store-counts'] });
      void qc.invalidateQueries({ queryKey: ['merchant-store'] });
    },
  });
}

// --- Categories ---------------------------------------------------------------

export function useCategories() {
  const api = useApi();
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const { data } = await api.get<Category[]>('/admin/categories', { params: { limit: 500 } });
      return data;
    },
  });
}

export function useCreateCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCategoryInput) => {
      const { data } = await api.post<Category>('/admin/categories', input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

export function useUpdateCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; input: UpdateCategoryInput }) => {
      const { data } = await api.patch<Category>(`/admin/categories/${args.id}`, args.input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}
