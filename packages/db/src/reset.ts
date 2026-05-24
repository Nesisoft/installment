import { config } from 'dotenv';
import pg from 'pg';
import { runMigrations } from './migrate';

config({ path: process.env.DOTENV_PATH ?? '../../.env' });

/**
 * Drops and recreates the `public` schema, then re-applies every migration.
 * Intended for local development and test setup ONLY — never run against a
 * database that holds real data.
 */
export async function resetDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refused: NODE_ENV=production');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env and ../../.env)');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    console.log('[reset] dropping schema public ...');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('[reset] schema recreated');
  } finally {
    await client.end();
  }

  await runMigrations();
  console.log('[reset] done');
}

if (require.main === module) {
  resetDatabase().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
