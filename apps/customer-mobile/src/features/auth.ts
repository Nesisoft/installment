import { useMutation } from '@tanstack/react-query';
import { useApi, useAuth } from '@installment/mobile-kit';
import type { AuthResult } from '@installment/api-types';
import { phoneE164 } from '../lib/format';

/**
 * Customer authentication: phone + OTP.
 *
 * Two flows share one screen, which is the point of `useStartAuth`. The API
 * separates them — `/auth/customer/otp/*` signs an existing customer in, and
 * `/auth/customer/signup/*` registers a new one — but a shopper typing their
 * number does not know which they are, and asking them to pick is a question
 * they cannot answer. So the app tries sign-in first and falls back to sign-up
 * on a 404, and the screen only asks for a name when registration is what is
 * actually happening.
 */

export interface StartResult {
  /** `login` when the number is known, `signup` when it is not. */
  mode: 'login' | 'signup';
  expiresAt: string;
}

export function useStartAuth() {
  const api = useApi();
  return useMutation({
    mutationFn: async (rawPhone: string): Promise<StartResult> => {
      const phone = phoneE164(rawPhone);
      try {
        const { data } = await api.post<{ expiresAt: string }>('/auth/customer/otp/start', {
          phone,
        });
        return { mode: 'login', expiresAt: data.expiresAt };
      } catch (err) {
        // A number with no customer behind it is a registration, not a failure.
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status !== 404) throw err;
        const { data } = await api.post<{ expiresAt: string }>('/auth/customer/signup/start', {
          phone,
        });
        return { mode: 'signup', expiresAt: data.expiresAt };
      }
    },
  });
}

/** Complete a sign-in: the code is enough, the account already exists. */
export function useVerifyLogin() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) => {
      const { data } = await api.post<AuthResult>('/auth/customer/otp/verify', {
        phone: phoneE164(phone),
        code,
      });
      await signIn(data);
      return data;
    },
  });
}

/**
 * Step two of registration: prove the code and get a ticket.
 *
 * Deliberately separate from creating the account. The ticket carries the
 * verified number, so the number that was proven is the number that gets
 * registered — a customer cannot verify one phone and sign up another.
 */
export function useVerifySignupCode() {
  const api = useApi();
  return useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) => {
      const { data } = await api.post<{ signupToken: string }>(
        '/auth/customer/signup/verify-code',
        { phone: phoneE164(phone), code },
      );
      return data.signupToken;
    },
  });
}

export interface CompleteSignupInput {
  signupToken: string;
  first_name: string;
  last_name: string;
  email?: string;
  /** Processing and credit scoring are required for a BNPL account; marketing is not. */
  marketing: boolean;
}

export function useCompleteSignup() {
  const api = useApi();
  const { signIn } = useAuth();
  return useMutation({
    mutationFn: async ({ marketing, ...rest }: CompleteSignupInput) => {
      const { data } = await api.post<AuthResult>('/auth/customer/signup/complete', {
        ...rest,
        consents: { data_processing: true, credit_scoring: true, marketing },
      });
      await signIn(data);
      return data;
    },
  });
}
