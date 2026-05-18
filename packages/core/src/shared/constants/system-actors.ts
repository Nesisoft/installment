/**
 * System actor sentinel UUIDs (DEVELOPMENT-PLAN.md §3.1).
 *
 * These IDs appear in `actor_id` / `performed_by` / `created_by` columns during
 * Phases 1–2, before the `users` table exists. Migration 0002 seeds `users`
 * with these EXACT IDs before adding any FK constraints, so no backfill is ever
 * needed. Every worker, scheduler, and webhook handler must import its identity
 * from here — never hard-code a raw UUID.
 *
 * Reserved range: `00000000-0000-0000-0000-00000000XXXX` is set aside for
 * system actors only. Never assign an ID in this range to a real user.
 */
export const SYSTEM_ACTORS = {
  /** Catch-all for actions with no specific worker. */
  SYSTEM: '00000000-0000-0000-0000-000000000001',
  /** The hourly Debit Scheduler. */
  SCHEDULER: '00000000-0000-0000-0000-000000000002',
  /** The Debit Worker (calls Paystack). */
  DEBIT_WORKER: '00000000-0000-0000-0000-000000000003',
  /** Paystack webhook handler. */
  WEBHOOK: '00000000-0000-0000-0000-000000000004',
  /** Nightly reconciliation worker. */
  RECONCILER: '00000000-0000-0000-0000-000000000005',
  /** Automated collections escalation worker. */
  COLLECTIONS_BOT: '00000000-0000-0000-0000-000000000006',
  /** Daily merchant settlement worker. */
  SETTLEMENT_WORKER: '00000000-0000-0000-0000-000000000007',
  /** MoMo verification poll worker. */
  VERIFY_WORKER: '00000000-0000-0000-0000-000000000008',
  /** SMS / email dispatcher. */
  NOTIFICATION_WORKER: '00000000-0000-0000-0000-000000000009',
  /** Dev / test fixture admin (not used in production). */
  SEED_ADMIN: '00000000-0000-0000-0000-000000000099',
} as const;

export type SystemActorName = keyof typeof SYSTEM_ACTORS;
export type SystemActorId = (typeof SYSTEM_ACTORS)[SystemActorName];

const SYSTEM_ACTOR_IDS: ReadonlySet<string> = new Set(Object.values(SYSTEM_ACTORS));

/** Type guard: is this string one of the reserved system actor UUIDs? */
export function isSystemActor(id: string): id is SystemActorId {
  return SYSTEM_ACTOR_IDS.has(id);
}
