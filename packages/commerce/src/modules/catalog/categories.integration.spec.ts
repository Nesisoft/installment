import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { AuditLogger, SYSTEM_ACTORS } from '@installment/core';
import { CategoriesService } from './categories.service';
import { CategoryConflictError, CategoryNotFoundError, CategoryValidationError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('CategoriesService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const categories = new CategoriesService(db, new AuditLogger());
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
