import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCategorySchema, listCategoriesSchema, updateCategorySchema } from './dto';

describe('createCategorySchema', () => {
  it('accepts a minimal category and defaults position to 0', () => {
    expect(createCategorySchema.parse({ name: 'Phones', slug: 'phones' })).toMatchObject({
      name: 'Phones',
      slug: 'phones',
      position: 0,
    });
  });

  it('rejects an invalid slug', () => {
    expect(createCategorySchema.safeParse({ name: 'X', slug: 'Not Valid' }).success).toBe(false);
  });

  it('accepts an optional parent_id uuid and rejects a bad one', () => {
    const id = randomUUID();
    expect(createCategorySchema.parse({ name: 'X', slug: 'x', parent_id: id }).parent_id).toBe(id);
    expect(createCategorySchema.safeParse({ name: 'X', slug: 'x', parent_id: 'bad' }).success).toBe(
      false,
    );
  });
});

describe('updateCategorySchema', () => {
  it('allows explicitly nulling the parent', () => {
    expect(updateCategorySchema.parse({ parent_id: null }).parent_id).toBeNull();
  });
});

describe('listCategoriesSchema', () => {
  it('defaults limit and offset', () => {
    expect(listCategoriesSchema.parse({})).toMatchObject({ limit: 200, offset: 0 });
  });
});
