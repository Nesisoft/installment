import { beforeAll } from 'vitest';
import { testDatabaseUrl, truncateTransactionalTables } from '@installment/db';

/**
 * Runs in each worker, once per spec file, before the file's own `beforeAll`.
 * Files within a worker are sequential, so this gives every spec a database
 * holding only the seeded reference data — which is what makes an assertion on
 * a global ledger account (`paystack_settlement['main']`) mean anything.
 */
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await truncateTransactionalTables(testDatabaseUrl());
});
