import { describe, expect, it } from 'vitest';
import {
  attachGhanaCardSchema,
  listCustomersSchema,
  recordConsentSchema,
  registerCustomerSchema,
  setBlocklistSchema,
  setMomoSchema,
} from './dto';

const valid = {
  first_name: 'Ama',
  last_name: 'Mensah',
  email: 'ama@example.com',
  phone: '0244123456',
};

describe('registerCustomerSchema', () => {
  it('canonicalises the phone via ghPhoneNumber', () => {
    const parsed = registerCustomerSchema.parse(valid);
    expect(parsed.phone).toBe('+233244123456');
  });

  it('rejects bad email, bad phone, bad date_of_birth', () => {
    expect(registerCustomerSchema.safeParse({ ...valid, email: 'x' }).success).toBe(false);
    expect(registerCustomerSchema.safeParse({ ...valid, phone: '0144123456' }).success).toBe(false);
    expect(
      registerCustomerSchema.safeParse({ ...valid, date_of_birth: '2026/05/21' }).success,
    ).toBe(false);
  });

  it('accepts optional consents as booleans', () => {
    expect(
      registerCustomerSchema.parse({
        ...valid,
        consents: { data_processing: true, marketing: false },
      }).consents,
    ).toEqual({ data_processing: true, marketing: false });
  });
});

describe('attachGhanaCardSchema', () => {
  it('canonicalises the Ghana Card number', () => {
    const parsed = attachGhanaCardSchema.parse({
      ghana_card_number: ' gha 123456789 0 ',
      ghana_card_image_key: 's3://bucket/key.jpg',
    });
    expect(parsed.ghana_card_number).toBe('GHA-123456789-0');
  });

  it('rejects missing image_key', () => {
    expect(
      attachGhanaCardSchema.safeParse({
        ghana_card_number: 'GHA-123456789-0',
        ghana_card_image_key: '',
      }).success,
    ).toBe(false);
  });
});

describe('setMomoSchema', () => {
  it('canonicalises momo_phone and enforces provider enum', () => {
    expect(setMomoSchema.parse({ momo_phone: '0244123456', momo_provider: 'mtn' })).toEqual({
      momo_phone: '+233244123456',
      momo_provider: 'mtn',
    });
    expect(
      setMomoSchema.safeParse({ momo_phone: '0244123456', momo_provider: 'glo' }).success,
    ).toBe(false);
  });
});

describe('setBlocklistSchema', () => {
  it('requires a non-empty reason', () => {
    expect(setBlocklistSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(setBlocklistSchema.parse({ reason: 'Identity mismatch' })).toEqual({
      reason: 'Identity mismatch',
    });
  });
});

describe('recordConsentSchema', () => {
  it('accepts only the three known consent types', () => {
    for (const t of ['data_processing', 'credit_scoring', 'marketing'] as const) {
      expect(recordConsentSchema.parse({ type: t })).toEqual({ type: t });
    }
    expect(recordConsentSchema.safeParse({ type: 'newsletter' }).success).toBe(false);
  });
});

describe('listCustomersSchema', () => {
  it('defaults limit and offset', () => {
    expect(listCustomersSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('clamps kyc_tier to {0,1,2}', () => {
    expect(listCustomersSchema.safeParse({ kyc_tier: 3 }).success).toBe(false);
    expect(listCustomersSchema.parse({ kyc_tier: 1 }).kyc_tier).toBe(1);
  });
});
