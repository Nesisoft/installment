import { describe, expect, it } from 'vitest';
import { listApplicationsSchema, recordDecisionSchema, submitApplicationSchema } from './dto';

const validSubmit = {
  customer_id: '11111111-1111-1111-1111-111111111111',
  merchant_id: '22222222-2222-2222-2222-222222222222',
  plan_template_id: '33333333-3333-3333-3333-333333333333',
  order_reference: 'ORD-1',
  order_amount_pesewas: 50_000,
  merchant_category: 'electronics',
};

describe('submitApplicationSchema', () => {
  it('accepts a valid submission', () => {
    expect(submitApplicationSchema.parse(validSubmit).order_amount_pesewas).toBe(50_000);
  });

  it('rejects non-uuid ids and non-positive amounts', () => {
    expect(submitApplicationSchema.safeParse({ ...validSubmit, customer_id: 'x' }).success).toBe(
      false,
    );
    expect(
      submitApplicationSchema.safeParse({ ...validSubmit, order_amount_pesewas: 0 }).success,
    ).toBe(false);
  });
});

describe('recordDecisionSchema', () => {
  it('accepts approved / declined without counter amounts', () => {
    expect(recordDecisionSchema.parse({ outcome: 'approved' }).outcome).toBe('approved');
    expect(
      recordDecisionSchema.parse({ outcome: 'declined', declined_reason: 'thin file' }).outcome,
    ).toBe('declined');
  });

  it('requires counter amounts for counter_offer', () => {
    expect(recordDecisionSchema.safeParse({ outcome: 'counter_offer' }).success).toBe(false);
    expect(
      recordDecisionSchema.safeParse({
        outcome: 'counter_offer',
        counter_down_payment_pesewas: 10_000,
        counter_financed_pesewas: 40_000,
      }).success,
    ).toBe(true);
  });
});

describe('listApplicationsSchema', () => {
  it('defaults pagination and validates the status enum', () => {
    expect(listApplicationsSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(listApplicationsSchema.safeParse({ status: 'frozen' }).success).toBe(false);
  });
});
