import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '@installment/db';
import {
  AuditLogger,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from './products.service';
import { MediaService } from './media';
import { StorefrontService } from './storefront.service';
import { PRODUCT_SORTS } from './storefront.dto';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Paging the catalogue must not repeat a product or lose one.
 *
 * `LIMIT`/`OFFSET` is only coherent over a TOTAL order. Where two rows tie on
 * every `ORDER BY` term, Postgres may return them in a different sequence for
 * each query — it makes no promise otherwise — so page 2 can hand back a
 * product page 1 already showed while another product appears on no page at
 * all. Nothing errors. The shopper simply never sees some of the catalogue.
 *
 * Every sort here used to end at `created_at`, which is nowhere near unique:
 * the column defaults to `NOW()`, and `NOW()` is transaction-start time, held
 * constant for the whole transaction. So one seed run, one bulk import or one
 * batch upload writes an identical timestamp to every row it inserts. On the
 * dev catalogue that was eight products of ten sharing a single value.
 *
 * This fixture reproduces that deliberately — every product is inserted and
 * then stamped with ONE timestamp — because a fixture that let `created_at`
 * differ per row would pass against the old code and prove nothing.
 */
describe.skipIf(!RUN_DB)('paging the catalogue (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /** Enough to page several times over, and all on one timestamp. */
  const CATALOGUE = 12;
  const PAGE = 4;

  let storeId: string;
  let ids: string[];

  beforeAll(async () => {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Paging Co ${id.slice(0, 8)}`,
        legal_name: 'Paging Co Ltd',
        email: `paging+${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `paging-${id.slice(0, 8)}`, display_name: 'Paging Co' },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    storeId = store.id;

    ids = [];
    for (let n = 0; n < CATALOGUE; n += 1) {
      const product = await products.create(
        {
          store_id: storeId,
          // Identical prices too, so `price_asc` and `price_desc` tie on their
          // leading term as well and lean entirely on the tiebreak.
          title: `Paged item ${String(n).padStart(2, '0')}`,
          base_price_pesewas: 25_000,
          status: 'active',
          variants: [
            { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 5 },
          ],
        },
        ACTOR,
      );
      ids.push(product.id);
    }

    // The whole point of the fixture: one timestamp across the lot, the way a
    // seed or a bulk import leaves it.
    await db.execute(
      sql`UPDATE products SET created_at = '2026-01-01T00:00:00Z' WHERE store_id = ${storeId}`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Walks the whole shelf `PAGE` at a time, the way the app now does. */
  async function pageThrough(sort: string): Promise<string[]> {
    const seen: string[] = [];
    for (let offset = 0; offset < CATALOGUE; offset += PAGE) {
      const page = await storefront.browse({ store_id: storeId, sort, limit: PAGE, offset });
      seen.push(...page.rows.map((r) => r.id));
    }
    return seen;
  }

  it.each([...PRODUCT_SORTS])('walks every product exactly once, sorted by %s', async (sort) => {
    const seen = await pageThrough(sort);

    // Both halves matter and they fail differently: a duplicate is a product
    // shown twice (and a duplicate React key), a short set is a product the
    // shopper can never reach however far they scroll.
    expect(new Set(seen).size).toBe(CATALOGUE);
    expect(seen).toHaveLength(CATALOGUE);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('returns the same order when the same page is asked for twice', async () => {
    // Stability is the property `LIMIT`/`OFFSET` actually depends on. A sort
    // that shuffles between two identical queries cannot be paged at all.
    const first = await storefront.browse({ store_id: storeId, limit: PAGE, offset: PAGE });
    const second = await storefront.browse({ store_id: storeId, limit: PAGE, offset: PAGE });

    expect(second.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  it('agrees with its own total', async () => {
    // The header prints this number and the paging loop stops on it, so a
    // count that disagreed with the rows would either hide products or leave
    // the app asking for a page that does not exist.
    const first = await storefront.browse({ store_id: storeId, limit: PAGE, offset: 0 });

    expect(first.total).toBe(CATALOGUE);
    expect((await pageThrough('popular')).length).toBe(first.total);
  });

  it('runs off the end cleanly rather than wrapping', async () => {
    const past = await storefront.browse({ store_id: storeId, limit: PAGE, offset: CATALOGUE });

    expect(past.rows).toEqual([]);
    expect(past.total).toBe(CATALOGUE);
  });

  /**
   * Why the tiebreak above is not decoration.
   *
   * The four tests before this one pin the contract, and they are worth having
   * — but they do NOT fail against the old code. At twelve rows Postgres sorts
   * the same way every time, so a fixture that size cannot tell a total order
   * from a lucky one. That is exactly what makes this class of bug survive
   * review: it is invisible until the table is big enough for the planner to
   * have a choice, and by then it is production.
   *
   * So this one reproduces it directly. Twenty thousand rows sharing one
   * timestamp, the same query twice, and the only difference is the plan the
   * planner is allowed to pick — which in production changes on its own as a
   * table grows, as statistics move and as load turns parallelism on and off.
   *
   * It is deliberately a temp table and raw SQL rather than the service: it is
   * a statement about `ORDER BY` over ties, and building twenty thousand real
   * products with variants and inventory to say it would be slower and no more
   * true.
   */
  it('proves ties really do page differently, which is the whole reason', async () => {
    await db.execute(sql`
      CREATE TEMP TABLE tie_demo AS
        SELECT gen_random_uuid() AS id, TIMESTAMPTZ '2026-01-01' AS created_at
        FROM generate_series(1, 20000)`);
    await db.execute(sql`ANALYZE tie_demo`);

    /** The same page, fetched under a plan we nudge one way or the other. */
    async function page(plan: 'serial' | 'parallel'): Promise<string[]> {
      await db.execute(
        plan === 'serial'
          ? sql`SET max_parallel_workers_per_gather = 0; SET work_mem = '128MB'`
          : sql`SET max_parallel_workers_per_gather = 4;
                SET parallel_setup_cost = 0;
                SET parallel_tuple_cost = 0;
                SET min_parallel_table_scan_size = 0;
                SET work_mem = '64kB'`,
      );
      const rows = await db.execute(
        sql`SELECT id::text FROM tie_demo ORDER BY created_at DESC LIMIT 5 OFFSET 10000`,
      );
      return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    }

    const serial = await page('serial');
    const parallel = await page('parallel');

    // Identical query, identical data, and not one row in common. Every one of
    // those five products is on page N under one plan and on some other page
    // under the other — shown twice to one shopper and never to the next.
    expect(serial).toHaveLength(5);
    expect(serial.filter((id) => parallel.includes(id))).toEqual([]);

    // And with the tiebreak this fix adds, the same two plans agree exactly.
    async function tiebroken(plan: 'serial' | 'parallel'): Promise<string[]> {
      await db.execute(
        plan === 'serial'
          ? sql`SET max_parallel_workers_per_gather = 0; SET work_mem = '128MB'`
          : sql`SET max_parallel_workers_per_gather = 4;
                SET parallel_setup_cost = 0;
                SET parallel_tuple_cost = 0;
                SET min_parallel_table_scan_size = 0;
                SET work_mem = '64kB'`,
      );
      const rows = await db.execute(
        sql`SELECT id::text FROM tie_demo ORDER BY created_at DESC, id DESC LIMIT 5 OFFSET 10000`,
      );
      return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    }

    expect(await tiebroken('parallel')).toEqual(await tiebroken('serial'));

    await db.execute(sql`RESET ALL`);
    await db.execute(sql`DROP TABLE tie_demo`);
  });
});
