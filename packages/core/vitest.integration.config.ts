import { defineConfig } from 'vitest/config';

// Must match TEST_DB_WORKERS in @installment/db — globalSetup provisions
// exactly this many databases and each worker claims the one matching its id.
const WORKERS = Number(process.env.VITEST_DB_WORKERS ?? 4);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    globalSetup: ['./vitest.integration.global.ts'],
    setupFiles: ['./vitest.integration.setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { minForks: WORKERS, maxForks: WORKERS } },
    // Workers are separate processes, so the namespace has to reach them here
    // as well as in globalSetup.
    env: { VITEST_DB_NAMESPACE: 'core' },
  },
});
