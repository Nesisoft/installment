/**
 * Test fixture user UUIDs (DEVELOPMENT-PLAN.md §3.1).
 *
 * Used by tests that simulate human actors. The `aaaaaaaa-...` prefix makes it
 * obvious in logs and test failures that you're looking at a fixture, not a
 * real user or a system actor. Seeded into `users` only in non-production
 * environments by migration 0002.
 */
export const FIXTURE_USERS = {
  /** Tests simulating an admin user. */
  FIXTURE_ADMIN_JANE: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
  /** Tests simulating a collections agent. */
  FIXTURE_AGENT_KOFI: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002',
  /** Tests simulating a customer-initiated action. */
  FIXTURE_CUSTOMER_AMA: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003',
} as const;

export type FixtureUserName = keyof typeof FIXTURE_USERS;
export type FixtureUserId = (typeof FIXTURE_USERS)[FixtureUserName];
