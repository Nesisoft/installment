import { z } from 'zod';
import { ghPhoneNumber } from '../../shared/validators/ghana';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const otpStartSchema = z.object({
  phone: ghPhoneNumber,
});
export type OtpStartInput = z.infer<typeof otpStartSchema>;

export const otpVerifySchema = z.object({
  phone: ghPhoneNumber,
  code: z.string().regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;
