import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  otpStartSchema,
  otpVerifySchema,
  refreshSchema,
  signupVerifySchema,
} from './dto';

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

  describe('signupVerifySchema', () => {
    const base = {
      phone: '0244123456',
      code: '123456',
      first_name: 'Ama',
      last_name: 'Mensah',
    };

    it('accepts a complete signup and canonicalises the phone', () => {
      const parsed = signupVerifySchema.parse({
        ...base,
        consents: { data_processing: true, credit_scoring: true, marketing: true },
      });
      expect(parsed.phone).toBe('+233244123456');
      expect(parsed.consents.marketing).toBe(true);
    });

    it('defaults marketing consent to off — it must be opted into, not out of', () => {
      const parsed = signupVerifySchema.parse({
        ...base,
        consents: { data_processing: true, credit_scoring: true },
      });
      expect(parsed.consents.marketing).toBe(false);
    });

    it('refuses to create an account without data-processing consent', () => {
      const result = signupVerifySchema.safeParse({
        ...base,
        consents: { data_processing: false, credit_scoring: true },
      });
      expect(result.success).toBe(false);
    });

    it('refuses to create an account without credit-scoring consent', () => {
      const result = signupVerifySchema.safeParse({
        ...base,
        consents: { data_processing: true, credit_scoring: false },
      });
      expect(result.success).toBe(false);
    });

    it('requires a name', () => {
      expect(
        signupVerifySchema.safeParse({
          ...base,
          first_name: '',
          consents: { data_processing: true, credit_scoring: true },
        }).success,
      ).toBe(false);
    });

    it('treats email as optional (customers authenticate by phone)', () => {
      const parsed = signupVerifySchema.parse({
        ...base,
        consents: { data_processing: true, credit_scoring: true },
      });
      expect(parsed.email).toBeUndefined();
    });
  });
});
