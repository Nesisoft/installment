import { describe, expect, it } from 'vitest';
import { LEDGER_ACCOUNT_TYPES, PERMISSIONS } from '@installment/core';
import { CATALOG_PERMISSIONS, MERCHANT_STATS_WINDOWS } from '@installment/commerce';
import {
  PERMISSIONS as MIRRORED_PERMISSIONS,
  LEDGER_ACCOUNT_TYPES as MIRRORED_LEDGER_ACCOUNT_TYPES,
  MERCHANT_STATS_WINDOWS as MIRRORED_MERCHANT_STATS_WINDOWS,
} from '@installment/api-types';

/**
 * S15 — the mirror that kept drifting.
 *
 * `@installment/api-types` re-declares the backend's enums by hand so the React
 * apps get them without pulling in Drizzle. Nothing checked the copy, and it
 * silently fell behind three separate times:
 *
 *   - `settlements:run` (S8) — a permission the API enforced and the console's
 *     types did not know existed.
 *   - `customer_float` (S5a) — a ledger account the engine had been posting to
 *     for two slices.
 *   - the refund enums (S7).
 *
 * Each was found by hand, later, while working on something else. The package
 * has no test runner of its own, so the gate lives here — `apps/api` is the
 * only workspace that can see the engine, commerce and the published contract
 * at once, and it is where the HTTP surface these types describe is assembled.
 */
describe('api-types mirrors the backend contract', () => {
  it('lists every permission the API can enforce', () => {
    const enforced = [...Object.values(PERMISSIONS), ...Object.values(CATALOG_PERMISSIONS)].sort();
    // Exact, not a superset: a name in the mirror that the API does not enforce
    // is just as broken — the console would offer a grant that does nothing.
    expect([...MIRRORED_PERMISSIONS].sort()).toEqual(enforced);
  });

  it('lists every ledger account the engine can post to', () => {
    // Compared as values rather than asserted as types: vitest runs through
    // esbuild, which strips type annotations without checking them, so a
    // compile-time-only assertion here would pass no matter what the mirror
    // said. `customer_float` went missing for two slices behind exactly that
    // kind of unchecked declaration.
    expect([...MIRRORED_LEDGER_ACCOUNT_TYPES].sort()).toEqual([...LEDGER_ACCOUNT_TYPES].sort());
  });

  it('lists every analytics window the merchant stats endpoint will serve', () => {
    // The endpoint refuses a window it does not offer rather than clamping to
    // the nearest one, so a client built against a drifted mirror does not get
    // approximate numbers — it gets a 400 nobody expected.
    expect([...MIRRORED_MERCHANT_STATS_WINDOWS]).toEqual([...MERCHANT_STATS_WINDOWS]);
  });
});
