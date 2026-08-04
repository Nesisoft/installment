import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { SYSTEM_ACTORS } from './system-actors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Contract test for migration 0002_users_and_rbac.sql: every SYSTEM_ACTORS
 * sentinel except SEED_ADMIN must be seeded as a real users row with
 * user_type='system' and is_active=true.
 */
describe.skipIf(!RUN_DB)('SYSTEM_ACTORS ↔ users seed (integration)', () => {
  const { db, pool } = createTestDb();

  afterAll(async () => {
    await pool.end();
  });

  it('every non-SEED_ADMIN sentinel UUID exists in users as a system row', async () => {
    const { SEED_ADMIN, ...required } = SYSTEM_ACTORS;
    void SEED_ADMIN;
    const ids = Object.values(required);

    const rows = await db
      .select({
        id: schema.users.id,
        user_type: schema.users.user_type,
        is_active: schema.users.is_active,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, ids));

    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(row.user_type).toBe('system');
      expect(row.is_active).toBe(true);
    }
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
  });
});
