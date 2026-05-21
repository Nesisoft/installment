import { describe, expect, it } from 'vitest';
import {
  attachPaystackRecipientSchema,
  createMerchantSchema,
  listMerchantsSchema,
  transitionMerchantSchema,
  updateMerchantSchema,
} from './dto';

const valid = {
  business_name: 'Ejua Mart',
  legal_name: 'Ejua Ghana Limited',
  email: 'ops@ejua.gh',
  phone: '+233244123456',
};

describe('createMerchantSchema', () => {
  it('accepts a minimal merchant and fills defaults', () => {
    const parsed = createMerchantSchema.parse(valid);
    expect(parsed).toMatchObject({
      ...valid,
      default_business_model: 'bnpl',
      default_mdr_bps: 400,
      default_reserve_bps: 500,
    });
  });

  it('clamps and validates basis-points fields', () => {
    expect(createMerchantSchema.safeParse({ ...valid, default_mdr_bps: -1 }).success).toBe(false);
    expect(createMerchantSchema.safeParse({ ...valid, default_mdr_bps: 2001 }).success).toBe(false);
    expect(createMerchantSchema.safeParse({ ...valid, default_reserve_bps: 5001 }).success).toBe(
      false,
    );
  });

  it('rejects invalid business model and bad email', () => {
    expect(
      createMerchantSchema.safeParse({ ...valid, default_business_model: 'crypto' }).success,
    ).toBe(false);
    expect(createMerchantSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('updateMerchantSchema', () => {
  it('accepts a partial patch', () => {
    expect(updateMerchantSchema.parse({ business_name: 'Renamed' })).toEqual({
      business_name: 'Renamed',
    });
  });
});

describe('transitionMerchantSchema', () => {
  it('accepts each legal event', () => {
    for (const event of ['activate', 'suspend', 'reactivate', 'offboard'] as const) {
      expect(transitionMerchantSchema.parse({ event })).toEqual({ event });
    }
  });

  it('rejects unknown events', () => {
    expect(transitionMerchantSchema.safeParse({ event: 'archive' }).success).toBe(false);
  });
});

describe('attachPaystackRecipientSchema', () => {
  it('requires a non-empty recipient code', () => {
    expect(attachPaystackRecipientSchema.safeParse({ paystack_recipient_code: '' }).success).toBe(
      false,
    );
    expect(
      attachPaystackRecipientSchema.parse({ paystack_recipient_code: 'RCP_xyz' }),
    ).toMatchObject({ paystack_recipient_code: 'RCP_xyz' });
  });
});

describe('listMerchantsSchema', () => {
  it('defaults limit=50 and offset=0', () => {
    expect(listMerchantsSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('clamps limit to <=200', () => {
    expect(listMerchantsSchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});
