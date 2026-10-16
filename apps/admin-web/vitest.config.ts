import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the console's pure logic — here, how a typed rate becomes the
 * number sent to the API. Component rendering is not covered.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
