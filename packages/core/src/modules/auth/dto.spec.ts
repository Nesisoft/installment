import { describe, expect, it } from 'vitest';
import { loginSchema, otpStartSchema, otpVerifySchema, refreshSchema } from './dto';

describe('auth DTOs', () => {
  it('loginSchema requires a valid email and non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'x', password: 'p' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.gh', password: '' }).success).toBe(false);
    expect(loginSchema.parse({ email: 'a@b.gh', password: 'p' }).email).toBe('a@b.gh');
  });

  it('otpStartSchema canonicalises the phone', () => {
    expect(otpStartSchema.parse({ phone: '0244123456' }).phone).toBe('+233244123456');
  });

  it('otpVerifySchema enforces a 4–8 digit code', () => {
    expect(otpVerifySchema.safeParse({ phone: '0244123456', code: 'abcd' }).success).toBe(false);
    expect(otpVerifySchema.safeParse({ phone: '0244123456', code: '12' }).success).toBe(false);
    expect(otpVerifySchema.parse({ phone: '0244123456', code: '123456' }).code).toBe('123456');
  });

  it('refreshSchema requires a token', () => {
    expect(refreshSchema.safeParse({ refreshToken: '' }).success).toBe(false);
  });
});
