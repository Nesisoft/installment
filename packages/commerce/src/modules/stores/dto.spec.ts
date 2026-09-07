import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GHANA_REGIONS } from '@installment/core';
import {
  createStoreSchema,
  listStoresSchema,
  transitionStoreSchema,
  updateMyStoreSchema,
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

describe('where the shop trades', () => {
  it("accepts every one of Ghana's sixteen regions", () => {
    expect(GHANA_REGIONS).toHaveLength(16);
    for (const region of GHANA_REGIONS) {
      expect(createStoreSchema.safeParse({ ...valid, region }).success).toBe(true);
    }
  });

  it('refuses a region that is not one of them', () => {
    // The names that would otherwise get written: the old ten-region
    // vocabulary, an abbreviation, and a country.
    for (const region of ['Brong Ahafo', 'Gt. Accra', 'greater accra', 'Accra', 'Ghana']) {
      expect(createStoreSchema.safeParse({ ...valid, region }).success).toBe(false);
    }
  });

  it('takes any city, because markets are not an enumerable list', () => {
    for (const city of ['Accra', 'Kumasi', 'Techiman', 'Sekondi-Takoradi']) {
      expect(createStoreSchema.safeParse({ ...valid, city }).success).toBe(true);
    }
    expect(createStoreSchema.safeParse({ ...valid, city: '' }).success).toBe(false);
  });

  it('lets a seller clear both with null, and leave them alone by omission', () => {
    // The distinction the storefront depends on: `null` empties the column,
    // absent leaves whatever is there. Without the nullable a city set once
    // could never be removed.
    expect(updateMyStoreSchema.parse({ city: null, region: null })).toEqual({
      city: null,
      region: null,
    });
    expect(updateMyStoreSchema.parse({ display_name: 'Adepa Couture' })).toEqual({
      display_name: 'Adepa Couture',
    });
  });

  it("is on the merchant's own patch schema, not only the admin one", () => {
    // The whole point of the field: a seller sets their own market at shop
    // setup. `updateMyStoreSchema` omits `slug`, so a mis-derived omit could
    // silently take these with it.
    const shape = Object.keys(updateMyStoreSchema.shape);
    expect(shape).toContain('city');
    expect(shape).toContain('region');
    expect(shape).not.toContain('slug');
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
