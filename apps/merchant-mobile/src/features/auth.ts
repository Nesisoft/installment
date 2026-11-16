import { useMutation } from '@tanstack/react-query';
import { useApi, useAuth } from '@installment/mobile-kit';
import type { AuthResult, MerchantSignupCompleteInput } from '@installment/api-types';

/**
 * Merchant authentication: email + password.
 *
 * Not phone + OTP, which is how the shopper app signs in. A shop is not a
 * person — staff change, the owner is not always the one at the counter — and
 * the portal's whole scoping model hangs off `users.metadata.merchant_id`,
 * which is set when the account is created rather than derived from whoever
 * holds the handset. `/auth/login` is the same endpoint the admin console uses.
 *
 * Opening a shop is below: a phone code, then the account. Everything else a
 * shop needs before it can trade — its category and market, the Ghana Card
 * documents Ejua reviews, the payout number — is the onboarding screen, which
 * a new seller is taken to straight after.
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

/**
 * Opening a shop, step 1: text a code to the seller's phone.
 *
 * Creates nothing. The code proves a person is behind the application before
 * anybody is asked to fill in a form, so an abandoned attempt leaves no rows.
 */
export function useStartShopSignup() {
  const api = useApi();
  return useMutation({
    mutationFn: async (phone: string) => {
      await api.post('/auth/merchant/signup/start', { phone });
    },
  });
}

/**
 * Step 2: the code buys a short-lived ticket for that number. The account is
 * created against the ticket, so nobody can prove one number and register
 * another.
 */
export function useVerifyShopSignupCode() {
  const api = useApi();
  return useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) => {
      const { data } = await api.post<{ signupToken: string }>(
        '/auth/merchant/signup/verify-code',
        { phone, code },
      );
      return data.signupToken;
    },
  });
}

/**
 * Step 3: create the merchant, its login and its shopfront, and sign in. The
 * shop is private until Ejua has reviewed it, so nothing a new seller does
 * before then is visible to buyers.
 */
export function useCompleteShopSignup() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async (body: MerchantSignupCompleteInput) => {
      const { data } = await api.post<AuthResult>('/auth/merchant/signup/complete', body);
      await signIn(data);
      return data;
    },
  });
}

// --- Passwords ---------------------------------------------------------------

/**
 * A forgotten password, step 1: text a code to the phone the shop was opened
 * with. The server answers the same whether or not the number runs a shop, and
 * texts nothing when it does not, so the screen says "if".
 */
export function useStartPasswordReset() {
  const api = useApi();
  return useMutation({
    mutationFn: async (phone: string) => {
      await api.post('/auth/merchant/password-reset/start', { phone });
    },
  });
}

/** Step 2: the code buys a short-lived ticket that can set a new password. */
export function useVerifyPasswordResetCode() {
  const api = useApi();
  return useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) => {
      const { data } = await api.post<{ resetToken: string }>(
        '/auth/merchant/password-reset/verify-code',
        { phone, code },
      );
      return data.resetToken;
    },
  });
}

/**
 * Step 3: the ticket sets the new password, and the answer is a session — the
 * seller is signed in. Any other device they were signed in on is signed out.
 */
export function useCompletePasswordReset() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async (body: { resetToken: string; new_password: string }) => {
      const { data } = await api.post<AuthResult>('/auth/merchant/password-reset/complete', body);
      await signIn(data);
      return data;
    },
  });
}

/**
 * Change the signed-in seller's password. The answer is a fresh session for
 * this device, stored at once: the old tokens stop renewing the moment the
 * password changes, here as on every other device.
 */
export function useChangePassword() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async (body: { current_password: string; new_password: string }) => {
      const { data } = await api.post<AuthResult>('/auth/password', body);
      await signIn(data);
      return data;
    },
  });
}
