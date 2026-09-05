import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the app's pure logic — formatting, dates, the derivations the
 * screens depend on. Component rendering is not covered here: it needs the
 * React Native preset (jest-expo), which is a separate, heavier setup than the
 * workspace's vitest runner.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
