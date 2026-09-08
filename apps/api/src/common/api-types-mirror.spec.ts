import { describe, expect, it } from 'vitest';
import {
  GHANA_CARD_STATUSES,
  GHANA_REGIONS,
  LEDGER_ACCOUNT_TYPES,
  PERMISSIONS,
  registerDeviceSchema,
} from '@installment/core';
import {
  CATALOG_PERMISSIONS,
  MERCHANT_RETURN_BUCKETS,
  MERCHANT_STATS_WINDOWS,
  RETURN_STATUSES,
} from '@installment/commerce';
import {
  PERMISSIONS as MIRRORED_PERMISSIONS,
  LEDGER_ACCOUNT_TYPES as MIRRORED_LEDGER_ACCOUNT_TYPES,
  MERCHANT_STATS_WINDOWS as MIRRORED_MERCHANT_STATS_WINDOWS,
  GHANA_CARD_STATUSES as MIRRORED_GHANA_CARD_STATUSES,
  GHANA_REGIONS as MIRRORED_GHANA_REGIONS,
  MERCHANT_RETURN_BUCKETS as MIRRORED_MERCHANT_RETURN_BUCKETS,
  RETURN_STATUSES as MIRRORED_RETURN_STATUSES,
  DEVICE_PLATFORMS as MIRRORED_DEVICE_PLATFORMS,
  registerDeviceSchema as mirroredRegisterDeviceSchema,
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

  it('lists every state a Ghana Card review can be in', () => {
    // The customer app branches on this to decide whether to offer the camera,
    // say "we are checking", or show the reviewer's reason — so a mirror that
    // drifted would leave a real state with no screen behind it.
    expect([...MIRRORED_GHANA_CARD_STATUSES]).toEqual([...GHANA_CARD_STATUSES]);
  });

  it('lists the regions a shop may say it trades in', () => {
    // `region` is a zod enum on both sides, so a mirror that gained or lost one
    // would let a client offer a region the API refuses — or refuse one it
    // accepts. The order matters too: both lists are rendered as-is in a
    // picker, and a reordered mirror is a reordered picker.
    expect([...MIRRORED_GHANA_REGIONS]).toEqual([...GHANA_REGIONS]);
  });

  it('lists every state a return can be in', () => {
    // The seller's queue chips are these values, and the CHECK constraint on
    // `order_returns.status` is the same list. A mirror that gained one would
    // give the app a filter the API refuses.
    expect([...MIRRORED_RETURN_STATUSES]).toEqual([...RETURN_STATUSES]);
    expect([...MIRRORED_MERCHANT_RETURN_BUCKETS]).toEqual([...MERCHANT_RETURN_BUCKETS]);
  });

  it('lists every analytics window the merchant stats endpoint will serve', () => {
    // The endpoint refuses a window it does not offer rather than clamping to
    // the nearest one, so a client built against a drifted mirror does not get
    // approximate numbers — it gets a 400 nobody expected.
    expect([...MIRRORED_MERCHANT_STATS_WINDOWS]).toEqual([...MERCHANT_STATS_WINDOWS]);
  });

  it('accepts and refuses exactly the device registrations the API does', () => {
    // Behavioural rather than structural, because the part that matters is the
    // token regex, and two regexes can differ in every character and agree on
    // every input — or match on the shape a handset produces and disagree on
    // the one a misconfigured project produces, which is the case worth
    // catching. The mobile apps run the mirrored copy BEFORE posting, so a
    // mirror that is stricter than the server silently stops registering
    // handsets and a mirror that is looser posts bodies that 400.
    const cases: unknown[] = [
      { expo_token: 'ExponentPushToken[abc123]', platform: 'android' },
      { expo_token: 'ExpoPushToken[abc123]', platform: 'ios', app_version: '1.0.0' },
      { expo_token: 'ExponentPushToken[abc]', platform: 'web', device_name: "Ama's Tecno" },
      // The shape a wrongly-credentialled project hands back: a raw FCM token.
      { expo_token: 'fY3_rawFcmTokenLookingThing', platform: 'android' },
      { expo_token: 'ExponentPushToken[]', platform: 'android' },
      { expo_token: '', platform: 'android' },
      { expo_token: 'ExponentPushToken[abc]', platform: 'windows' },
      { expo_token: 'ExponentPushToken[abc]' },
      { expo_token: `ExponentPushToken[${'x'.repeat(300)}]`, platform: 'android' },
      { expo_token: 'ExponentPushToken[abc]', platform: 'android', app_version: 'v'.repeat(41) },
      { expo_token: 'ExponentPushToken[abc]', platform: 'android', device_name: 'd'.repeat(121) },
    ];

    for (const input of cases) {
      const enforced = registerDeviceSchema.safeParse(input);
      const mirrored = mirroredRegisterDeviceSchema.safeParse(input);
      expect(mirrored.success, JSON.stringify(input)).toBe(enforced.success);
      if (enforced.success && mirrored.success) expect(mirrored.data).toEqual(enforced.data);
    }
  });

  it('lists every platform a handset may register as', () => {
    // The CHECK on `push_devices.platform` is this list, so a mirror that
    // gained one would let the app post a value the database refuses.
    expect([...MIRRORED_DEVICE_PLATFORMS]).toEqual(registerDeviceSchema.shape.platform.options);
  });
});
