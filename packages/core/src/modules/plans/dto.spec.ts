import { describe, expect, it } from 'vitest';
import { createPlanTemplateSchema, listPlanTemplatesSchema, updatePlanTemplateSchema } from './dto';

const valid = {
  name: 'BNPL 4× weekly',
  business_model: 'bnpl' as const,
  number_of_installments: 4,
  installment_frequency_days: 7 as const,
  min_amount_pesewas: 10_000,
  max_amount_pesewas: 1_000_000,
};

describe('createPlanTemplateSchema', () => {
  it('accepts the canonical BNPL shape and fills defaults', () => {
    const parsed = createPlanTemplateSchema.parse(valid);
    expect(parsed).toMatchObject({
      ...valid,
      down_payment_bps: 0,
      interest_rate_bps: 0,
      service_fee_flat_pesewas: 0,
      late_fee_pesewas: 0,
      grace_period_days: 3,
      eligible_categories: [],
      excluded_categories: [],
    });
  });

  it('enforces CHECK-aligned numeric ranges', () => {
    expect(
      createPlanTemplateSchema.safeParse({ ...valid, number_of_installments: 25 }).success,
    ).toBe(false);
    expect(
      createPlanTemplateSchema.safeParse({ ...valid, installment_frequency_days: 15 }).success,
    ).toBe(false);
    expect(createPlanTemplateSchema.safeParse({ ...valid, down_payment_bps: 10_001 }).success).toBe(
      false,
    );
    expect(createPlanTemplateSchema.safeParse({ ...valid, grace_period_days: 15 }).success).toBe(
      false,
    );
  });

  it('rejects max_amount < min_amount', () => {
    const r = createPlanTemplateSchema.safeParse({
      ...valid,
      min_amount_pesewas: 1_000_000,
      max_amount_pesewas: 10_000,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/max_amount_pesewas/);
  });

  it('rejects effective_to <= effective_from', () => {
    expect(
      createPlanTemplateSchema.safeParse({
        ...valid,
        effective_from: '2027-01-01T00:00:00.000Z',
        effective_to: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('updatePlanTemplateSchema', () => {
  it('accepts a partial patch', () => {
    expect(updatePlanTemplateSchema.parse({ name: 'New name' })).toEqual({ name: 'New name' });
  });

  it('keeps the max/min relationship on partial updates', () => {
    expect(
      updatePlanTemplateSchema.safeParse({
        min_amount_pesewas: 500_000,
        max_amount_pesewas: 100_000,
      }).success,
    ).toBe(false);
  });
});

describe('listPlanTemplatesSchema', () => {
  it('defaults limit and offset', () => {
    expect(listPlanTemplatesSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('accepts an effective_at filter and business_model enum', () => {
    expect(
      listPlanTemplatesSchema.parse({
        business_model: 'hybrid',
        effective_at: '2026-05-21T00:00:00.000Z',
      }).business_model,
    ).toBe('hybrid');
    expect(listPlanTemplatesSchema.safeParse({ business_model: 'crypto' }).success).toBe(false);
  });
});
