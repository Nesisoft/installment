import { z } from 'zod';
import type { Permission, UserType } from './enums';

// --- Request schemas (reused for client-side form validation) ---------------

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Ghana phone: accept 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX; the backend
// canonicalizes to E.164, so we validate loosely and let it normalize.
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?233|0)\d{9}$/, 'Enter a valid Ghana phone number');

export const otpStartSchema = z.object({ phone: phoneSchema });
export type OtpStartInput = z.infer<typeof otpStartSchema>;

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .length(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof refreshSchema>;

// --- Responses --------------------------------------------------------------

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  userId: string;
  userType: UserType;
  tokens: AuthTokens;
  permissions: Permission[];
}

export interface AuthenticatedUser {
  id: string;
  userType: UserType;
}

export interface OtpStartResult {
  expiresAt: string;
}
