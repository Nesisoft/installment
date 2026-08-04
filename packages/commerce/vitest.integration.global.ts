import { provisionTestDatabases, TEST_DB_WORKERS } from '@installment/db';

/**
 * Runs once before any worker starts: clones the migrated database into one
 * copy per worker, so parallel spec files cannot see each other's rows.
 *
 * The namespace keeps this suite's copies distinct from the other package's —
 * `pnpm --filter core --filter commerce test:integration` runs both at once.
 */
export async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) return; // suite self-skips without a database
  process.env.VITEST_DB_NAMESPACE = 'commerce';
  await provisionTestDatabases(TEST_DB_WORKERS);
}
