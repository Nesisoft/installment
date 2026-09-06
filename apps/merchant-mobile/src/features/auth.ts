import { useMutation } from '@tanstack/react-query';
import { useApi, useAuth } from '@installment/mobile-kit';
import type { AuthResult } from '@installment/api-types';

/**
 * Merchant authentication: email + password.
 *
 * Not phone + OTP, which is how the shopper app signs in. A shop is not a
 * person — staff change, the owner is not always the one at the counter — and
 * the portal's whole scoping model hangs off `users.metadata.merchant_id`,
 * which is set when the account is created rather than derived from whoever
 * holds the handset. `/auth/login` is the same endpoint merchant-web uses.
 *
 * Signing up is deliberately absent from this app. Registration collects a
 * business name, a category, a MoMo number and Ghana Card documents, and it
 * lands in a review queue — see `apps/merchant-web/src/pages/signup.tsx`. The
 * app's job starts once there is an account to sign in to.
 */
export function useSignIn() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const { data } = await api.post<AuthResult>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });
      await signIn(data);
      return data;
    },
  });
}
