import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger, SYSTEM_ACTORS } from '@installment/core';
import { CategoriesService } from './categories.service';
import { MediaService } from './media';
import { StorefrontService } from './storefront.service';
import { CategoryConflictError, CategoryNotFoundError, CategoryValidationError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('CategoriesService (integration)', () => {
  const { db, pool } = createTestDb();
  const categories = new CategoriesService(db, new AuditLogger());
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const slug = () => `cat-${randomUUID().slice(0, 8)}`;

  it('creates a top-level category and a child, and lists children', async () => {
    const parent = await categories.create({ name: 'Electronics', slug: slug() }, SYSTEM_ACTOR);
    expect(parent.parent_id).toBeNull();

    const child = await categories.create(
      { name: 'Phones', slug: slug(), parent_id: parent.id },
      SYSTEM_ACTOR,
    );
    expect(child.parent_id).toBe(parent.id);

    const children = await categories.list({ parent_id: parent.id });
    expect(children.map((c) => c.id)).toContain(child.id);
  });

  it('offers only top-level categories when the caller asks for them', async () => {
    // What the customer app's category rail and merchant signup's "what do you
    // sell?" both need. The rail has sent `top_level=true` since it was built
    // and nothing read it — harmless while the taxonomy was flat, and wrong the
    // moment it was not: Electronics listed beside Phones and Laptops presents
    // a category and two of its children as peers, and a merchant could file
    // their whole shop under "Laptops".
    const parent = await categories.create({ name: 'Appliances', slug: slug() }, SYSTEM_ACTOR);
    const child = await categories.create(
      { name: 'Kettles', slug: slug(), parent_id: parent.id },
      SYSTEM_ACTOR,
    );

    const top = await storefront.categories({ top_level: true });
    expect(top.map((c) => c.id)).toContain(parent.id);
    expect(top.map((c) => c.id)).not.toContain(child.id);
    expect(top.every((c) => c.parent_id === null)).toBe(true);

    // Unasked, the whole tree still comes back — the admin surface reads it.
    const all = await storefront.categories();
    expect(all.map((c) => c.id)).toContain(child.id);

    // Query strings arrive as strings.
    expect((await storefront.categories({ top_level: 'true' })).map((c) => c.id)).not.toContain(
      child.id,
    );
  });

  it('rejects a duplicate slug', async () => {
    const s = slug();
    await categories.create({ name: 'A', slug: s }, SYSTEM_ACTOR);
    await expect(categories.create({ name: 'B', slug: s }, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      CategoryConflictError,
    );
  });

  it('rejects a non-existent parent', async () => {
    await expect(
      categories.create({ name: 'X', slug: slug(), parent_id: randomUUID() }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(CategoryValidationError);
  });

  it('rejects self-parenting on update', async () => {
    const cat = await categories.create({ name: 'Self', slug: slug() }, SYSTEM_ACTOR);
    await expect(
      categories.update(cat.id, { parent_id: cat.id }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(CategoryValidationError);
  });

  it('refuses to file a category under its own subcategory', async () => {
    const top = await categories.create({ name: 'Home', slug: slug() }, SYSTEM_ACTOR);
    const mid = await categories.create(
      { name: 'Kitchen', slug: slug(), parent_id: top.id },
      SYSTEM_ACTOR,
    );
    const leaf = await categories.create(
      { name: 'Pots', slug: slug(), parent_id: mid.id },
      SYSTEM_ACTOR,
    );
    await expect(
      categories.update(top.id, { parent_id: leaf.id }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(CategoryValidationError);
    await expect(
      categories.update(mid.id, { parent_id: leaf.id }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(CategoryValidationError);
    // Moving a branch sideways or up is fine.
    const other = await categories.create({ name: 'Garden', slug: slug() }, SYSTEM_ACTOR);
    expect((await categories.update(mid.id, { parent_id: other.id }, SYSTEM_ACTOR)).parent_id).toBe(
      other.id,
    );
    expect(
      (await categories.update(mid.id, { parent_id: null }, SYSTEM_ACTOR)).parent_id,
    ).toBeNull();
  });

  it('deactivates via update so active_only filters it out', async () => {
    const cat = await categories.create({ name: 'Toggle', slug: slug() }, SYSTEM_ACTOR);
    await categories.update(cat.id, { is_active: false }, SYSTEM_ACTOR);
    const active = await categories.list({ active_only: true, top_level: true, limit: 500 });
    expect(active.find((c) => c.id === cat.id)).toBeUndefined();
  });

  it('throws for an unknown id', async () => {
    await expect(categories.get(randomUUID())).rejects.toBeInstanceOf(CategoryNotFoundError);
  });
});
