import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Integration specs need a real Postgres; they run via `test:integration`.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
