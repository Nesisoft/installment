import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';

config({ path: process.env.DOTENV_PATH ?? '../../.env' });

const SEEDS_DIR = resolve(__dirname, '../seeds');

/**
 * Applies dev-only seed data (SEED_ADMIN + FIXTURE_* users). Idempotent
 * thanks to ON CONFLICT DO NOTHING in the seed SQL. Refuses to run when
 * NODE_ENV=production.
 */
export async function seedDevFixtures(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedDevFixtures refused: NODE_ENV=production');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env and ../../.env)');
  }

  const sql = await readFile(resolve(SEEDS_DIR, 'dev-fixtures.sql'), 'utf8');

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    console.log('[seed:dev] applying dev-fixtures.sql ...');
    await client.query(sql);
    console.log('[seed:dev] done');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seedDevFixtures().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
