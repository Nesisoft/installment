import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the app's pure logic — the money derivations the screens
 * print. Component rendering is not covered here; this exists so that the
 * arithmetic a customer reads has somewhere to be checked.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
