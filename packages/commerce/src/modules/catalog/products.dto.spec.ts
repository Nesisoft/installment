import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adjustStockSchema,
  createProductSchema,
  searchProductsSchema,
  setStockSchema,
} from './products.dto';

const base = { store_id: randomUUID(), title: 'Phone', base_price_pesewas: 150_000 };

describe('createProductSchema', () => {
  it('accepts a minimal product', () => {
    expect(createProductSchema.parse(base)).toMatchObject({
      title: 'Phone',
      base_price_pesewas: 150_000,
    });
  });

  it('rejects a negative or non-integer price', () => {
    expect(createProductSchema.safeParse({ ...base, base_price_pesewas: -1 }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, base_price_pesewas: 1.5 }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(createProductSchema.safeParse({ ...base, status: 'live' }).success).toBe(false);
  });

  it('accepts nested variants, images and plan offers', () => {
    const parsed = createProductSchema.parse({
      ...base,
      variants: [{ sku: 'A', quantity_available: 5 }],
      images: [{ storage_key: 'img/1.jpg' }],
      plan_template_ids: [randomUUID()],
    });
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.plan_template_ids).toHaveLength(1);
  });
});

describe('searchProductsSchema', () => {
  it('requires q and defaults paging', () => {
    expect(searchProductsSchema.parse({ q: 'phone' })).toMatchObject({
      q: 'phone',
      limit: 50,
      offset: 0,
    });
    expect(searchProductsSchema.safeParse({}).success).toBe(false);
  });
});

describe('inventory schemas', () => {
  it('setStock requires a non-negative quantity', () => {
    expect(setStockSchema.safeParse({ quantity_available: -1 }).success).toBe(false);
    expect(setStockSchema.parse({ quantity_available: 10 }).quantity_available).toBe(10);
  });

  it('adjustStock accepts a signed delta', () => {
    expect(adjustStockSchema.parse({ delta: -3 }).delta).toBe(-3);
    expect(adjustStockSchema.safeParse({ delta: 1.5 }).success).toBe(false);
  });
});
