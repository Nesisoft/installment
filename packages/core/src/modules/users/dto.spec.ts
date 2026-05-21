import { describe, expect, it } from 'vitest';
import { createCustomerUserSchema, createMerchantUserSchema, createStaffSchema } from './dto';

describe('createStaffSchema', () => {
  const valid = { email: 'jane@ops.gh', name: 'Jane', password: 'longenough', user_type: 'admin' };

  it('accepts a valid admin/agent', () => {
    expect(createStaffSchema.parse(valid).user_type).toBe('admin');
    expect(createStaffSchema.parse({ ...valid, user_type: 'agent' }).user_type).toBe('agent');
  });

  it('enforces a minimum password length and the user_type enum', () => {
    expect(createStaffSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(createStaffSchema.safeParse({ ...valid, user_type: 'customer' }).success).toBe(false);
  });
});

describe('createMerchantUserSchema', () => {
  it('requires email + password', () => {
    expect(createMerchantUserSchema.safeParse({ name: 'M', email: 'm@x.gh' }).success).toBe(false);
    expect(
      createMerchantUserSchema.parse({ name: 'M', email: 'm@x.gh', password: 'longenough' }).email,
    ).toBe('m@x.gh');
  });
});

describe('createCustomerUserSchema', () => {
  it('canonicalises the phone and needs no password', () => {
    const parsed = createCustomerUserSchema.parse({ phone: '0244123456', name: 'Ama' });
    expect(parsed.phone).toBe('+233244123456');
  });

  it('rejects a non-Ghanaian phone', () => {
    expect(
      createCustomerUserSchema.safeParse({ phone: '+1 415 555 0100', name: 'X' }).success,
    ).toBe(false);
  });
});
