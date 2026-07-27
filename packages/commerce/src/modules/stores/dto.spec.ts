import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createStoreSchema,
  listStoresSchema,
  transitionStoreSchema,
  updateStoreSchema,
} from './dto';

const valid = { merchant_id: randomUUID(), slug: 'ejua-mart', display_name: 'Ejua Mart' };

describe('createStoreSchema', () => {
  it('accepts a minimal store', () => {
    expect(createStoreSchema.parse(valid)).toMatchObject({
      slug: 'ejua-mart',
      display_name: 'Ejua Mart',
    });
  });

  it('rejects bad slugs', () => {
    for (const slug of ['Ejua Mart', 'ejua_mart', '-ejua', 'ejua--mart', 'EJUA', 'ejua-', '']) {
      expect(createStoreSchema.safeParse({ ...valid, slug }).success).toBe(false);
    }
  });

  it('accepts good slugs', () => {
    for (const slug of ['ejua', 'ejua-mart', 'shop-123', 'a1']) {
      expect(createStoreSchema.safeParse({ ...valid, slug }).success).toBe(true);
    }
  });

  it('requires a valid merchant_id uuid', () => {
    expect(createStoreSchema.safeParse({ ...valid, merchant_id: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('validates support_email when present', () => {
    expect(createStoreSchema.safeParse({ ...valid, support_email: 'nope' }).success).toBe(false);
    expect(createStoreSchema.safeParse({ ...valid, support_email: 'help@ejua.gh' }).success).toBe(
      true,
    );
  });
});

describe('updateStoreSchema', () => {
  it('is partial and strips the immutable merchant_id', () => {
    expect(updateStoreSchema.parse({ merchant_id: randomUUID(), display_name: 'New' })).toEqual({
      display_name: 'New',
    });
  });
});

describe('transitionStoreSchema', () => {
  it('accepts known events and rejects unknown ones', () => {
    expect(transitionStoreSchema.parse({ event: 'activate' }).event).toBe('activate');
    expect(transitionStoreSchema.safeParse({ event: 'nuke' }).success).toBe(false);
  });
});

describe('listStoresSchema', () => {
  it('defaults limit and offset', () => {
    expect(listStoresSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });
});
