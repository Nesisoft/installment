import { describe, expect, it } from 'vitest';
import {
  GHANA_CARD_STATUSES,
  GHANA_REGIONS,
  LEDGER_ACCOUNT_TYPES,
  PERMISSIONS,
  REFUND_QUEUES,
  registerDeviceSchema,
} from '@installment/core';
import {
  CATALOG_PERMISSIONS,
  CUSTOMER_RETURN_BUCKETS,
  MERCHANT_RETURN_BUCKETS,
  MERCHANT_STATS_WINDOWS,
  RETURN_STATUSES,
  REVIEW_STATUSES,
  createProductSchema,
  createReviewSchema,
  dealRuleIssue,
  productCols,
  requestReturnSchema,
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
  CUSTOMER_RETURN_BUCKETS as MIRRORED_CUSTOMER_RETURN_BUCKETS,
  REVIEW_STATUSES as MIRRORED_REVIEW_STATUSES,
  createReviewSchema as mirroredCreateReviewSchema,
  createProductSchema as mirroredCreateProductSchema,
  dealRuleIssue as mirroredDealRuleIssue,
  PRODUCT_FIELDS as MIRRORED_PRODUCT_FIELDS,
  requestReturnSchema as mirroredRequestReturnSchema,
  REFUND_QUEUES as MIRRORED_REFUND_QUEUES,
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

  it('lists every queue a refund can be in', () => {
    // The console's refunds page offers these as its filter and decides which
    // buttons a row gets from them. The API refuses a queue it does not have,
    // so a mirror that gained one would be a filter that answers 400, and one
    // that lost one would hide every refund in it.
    expect([...MIRRORED_REFUND_QUEUES]).toEqual([...REFUND_QUEUES]);
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

  it("lists the buckets the buyer's own returns list can filter by", () => {
    // The buyer's chips and the seller's chips are the same four statuses, and
    // the point of asserting all three lists together is that they must not
    // drift APART: the two screens read the same rows from opposite sides.
    expect([...MIRRORED_CUSTOMER_RETURN_BUCKETS]).toEqual([...CUSTOMER_RETURN_BUCKETS]);
    expect([...CUSTOMER_RETURN_BUCKETS]).toEqual([...MERCHANT_RETURN_BUCKETS]);
  });

  it('accepts and refuses exactly the return reasons the API does', () => {
    // The mirror hardcoded `.max(1_000)` while the backend wrote
    // `.max(REQUEST_RETURN_REASON_MAX)`, and nothing compared them — raising
    // the constant on one side would have left the app silently refusing a
    // reason the API accepts, at the moment of writing it, with no error to
    // read. Both sides now name the constant and this pins them together.
    const cases: unknown[] = [
      { reason: 'Wrong size — the M is cut small.' },
      // Trimmed to empty is the refusal that matters: a return with no reason
      // is not reviewable, and the seller decides on the reason.
      { reason: '   ' },
      { reason: '' },
      {},
      { reason: 'x'.repeat(1_000) },
      { reason: 'x'.repeat(1_001) },
      // Trim happens before the length check on both sides, so this passes.
      { reason: `  ${'x'.repeat(1_000)}  ` },
      { reason: 42 },
    ];

    for (const input of cases) {
      const enforced = requestReturnSchema.safeParse(input);
      const mirrored = mirroredRequestReturnSchema.safeParse(input);
      expect(mirrored.success, JSON.stringify(input)).toBe(enforced.success);
      if (enforced.success && mirrored.success) expect(mirrored.data).toEqual(enforced.data);
    }
  });

  it('accepts and refuses exactly the reviews the API does', () => {
    // `rating` is a strict z.number() with no coercion, unlike every other
    // numeric field in this contract — a form posting the string "5" gets a
    // validation error rather than a review. That asymmetry is the single most
    // likely thing for a hand-written mirror to smooth over, so it is pinned
    // here rather than described in a comment somewhere.
    const ITEM = '3f1a9c62-0d4e-4d8b-9a77-2c5e6b4f1a80';
    const cases: unknown[] = [
      { order_item_id: ITEM, rating: 5 },
      { order_item_id: ITEM, rating: 4, title: 'Beautiful, runs small' },
      { order_item_id: ITEM, rating: 1, title: 'No', body: 'Not as described.' },
      { order_item_id: ITEM, rating: '5' },
      { order_item_id: ITEM, rating: 4.5 },
      { order_item_id: ITEM, rating: 0 },
      { order_item_id: ITEM, rating: 6 },
      { order_item_id: ITEM },
      { rating: 5 },
      { order_item_id: 'not-a-uuid', rating: 5 },
      { order_item_id: ITEM, rating: 3, title: 't'.repeat(161) },
      { order_item_id: ITEM, rating: 3, body: 'b'.repeat(4_001) },
      { order_item_id: ITEM, rating: 3, title: 't'.repeat(160), body: 'b'.repeat(4_000) },
    ];

    for (const input of cases) {
      const enforced = createReviewSchema.safeParse(input);
      const mirrored = mirroredCreateReviewSchema.safeParse(input);
      expect(mirrored.success, JSON.stringify(input)).toBe(enforced.success);
      if (enforced.success && mirrored.success) expect(mirrored.data).toEqual(enforced.data);
    }
  });

  it('lists every state a review can be in', () => {
    // Both the const and its backend counterpart are new in this slice: the
    // CHECK on `product_reviews.status` has always been these two values and
    // no TypeScript anywhere had ever named them, so there was nothing for a
    // mirror to be checked against. The literal is asserted too, because with
    // both sides new the pair could agree and still both be wrong about the
    // constraint they exist to describe.
    expect([...MIRRORED_REVIEW_STATUSES]).toEqual([...REVIEW_STATUSES]);
    expect([...REVIEW_STATUSES]).toEqual(['published', 'hidden']);
  });

  it('accepts and refuses exactly the listings the API does', () => {
    // The two sale fields were on neither schema, so a "was" price and a deal
    // countdown could only come from the seed. Adding them to two hand-written
    // copies is exactly how they drift, and the pair the app posts is the pair
    // the database has a CHECK about.
    const STORE = '9f2b4c11-6d3a-4f88-b0e7-1a5c9d2e6b40';
    const base = { store_id: STORE, title: 'Kente Scarf', base_price_pesewas: 6_990 };
    const cases: unknown[] = [
      base,
      { ...base, compare_at_price_pesewas: 9_990 },
      { ...base, compare_at_price_pesewas: null },
      { ...base, compare_at_price_pesewas: 9_990, deal_ends_at: '2026-12-24T23:59:00Z' },
      { ...base, compare_at_price_pesewas: 9_990, deal_ends_at: '2026-12-24T23:59:00+00:00' },
      // No offset: `.datetime({ offset: true })` still requires a Z or an
      // offset, and a bare local time is the shape a naive client sends.
      { ...base, compare_at_price_pesewas: 9_990, deal_ends_at: '2026-12-24T23:59:00' },
      { ...base, compare_at_price_pesewas: 9_990, deal_ends_at: 'christmas' },
      { ...base, compare_at_price_pesewas: 6_990.5 },
      { ...base, compare_at_price_pesewas: -1 },
      { ...base, compare_at_price_pesewas: '9990' },
    ];

    for (const input of cases) {
      const enforced = createProductSchema.safeParse(input);
      const mirrored = mirroredCreateProductSchema.safeParse(input);
      expect(mirrored.success, JSON.stringify(input)).toBe(enforced.success);
      if (enforced.success && mirrored.success) expect(mirrored.data).toEqual(enforced.data);
    }
  });

  it('applies the same sale rules on both sides, and the same ones the table does', () => {
    // `dealRuleIssue` is the cross-field half that no schema can express — a
    // "was" price is only valid RELATIVE to the price beside it. Two copies of
    // a rule that Postgres also holds is three places to disagree, so all
    // three are asserted together: the last two expectations restate
    // `products_compare_at_above_price` and `products_deal_needs_compare_at`
    // verbatim, because with both TypeScript copies new they could agree with
    // each other and still be wrong about the constraint.
    const rows = [
      { base_price_pesewas: 6_990, compare_at_price_pesewas: 9_990 },
      { base_price_pesewas: 6_990, compare_at_price_pesewas: 6_990 },
      { base_price_pesewas: 6_990, compare_at_price_pesewas: 1_000 },
      { base_price_pesewas: 6_990, compare_at_price_pesewas: null },
      { base_price_pesewas: 6_990 },
      { base_price_pesewas: 6_990, deal_ends_at: '2026-12-24T23:59:00Z' },
      {
        base_price_pesewas: 6_990,
        compare_at_price_pesewas: 9_990,
        deal_ends_at: '2026-12-24T23:59:00Z',
      },
      { base_price_pesewas: 6_990, compare_at_price_pesewas: null, deal_ends_at: null },
    ];

    for (const row of rows) {
      expect(mirroredDealRuleIssue(row), JSON.stringify(row)).toBe(dealRuleIssue(row));
    }

    // products_compare_at_above_price: NULL, or strictly above the price.
    expect(dealRuleIssue({ base_price_pesewas: 100, compare_at_price_pesewas: 101 })).toBeNull();
    expect(
      dealRuleIssue({ base_price_pesewas: 100, compare_at_price_pesewas: 100 }),
    ).not.toBeNull();
    expect(dealRuleIssue({ base_price_pesewas: 100, compare_at_price_pesewas: null })).toBeNull();
    // products_deal_needs_compare_at: an end date needs something to count from.
    expect(dealRuleIssue({ base_price_pesewas: 100, deal_ends_at: 'x' })).not.toBeNull();
  });

  it('declares every field the product read actually returns', () => {
    // The one kind of drift the rest of this file cannot see. Everything else
    // here compares runtime VALUES, because esbuild strips type annotations
    // without checking them — so an interface that has fallen behind the API
    // passes every assertion in this spec while a client cannot see half the
    // response.
    //
    // `productCols` is a real object, so its keys are checkable. It found four
    // on arrival: compare_at_price_pesewas, deal_ends_at, updated_at and
    // deleted_at were all being sent and declared by nothing, which is why the
    // seller's edit screen could not read back the sale it had just set.
    expect([...MIRRORED_PRODUCT_FIELDS].sort()).toEqual(Object.keys(productCols).sort());
  });

  it('lists every platform a handset may register as', () => {
    // The CHECK on `push_devices.platform` is this list, so a mirror that
    // gained one would let the app post a value the database refuses.
    expect([...MIRRORED_DEVICE_PLATFORMS]).toEqual(registerDeviceSchema.shape.platform.options);
  });
});
