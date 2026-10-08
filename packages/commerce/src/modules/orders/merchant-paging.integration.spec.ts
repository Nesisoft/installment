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
import { ProductsService } from '../catalog/products.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Paging the merchant portal's lists.
 *
 * The same defect `browse-paging.integration.spec.ts` pins for the shopper
 * catalogue, on the lists the seller pages through. `LIMIT`/`OFFSET` is only
 * coherent over a TOTAL order: where rows tie on every ORDER BY term, Postgres
 * may return them in a different sequence for each query, so page 2 can repeat
 * a row from page 1 while another row appears on no page at all. Nothing
 * errors — the seller just never sees part of their own catalogue.
 *
 * `ProductsService.list` ordered by `created_at` alone. That column defaults
 * to `NOW()`, which is transaction-start time and constant for a whole
 * transaction, so a seed, a bulk import or a batch upload stamps one identical
 * value across every row it writes.
 *
 * The fixture stamps one timestamp across the lot deliberately: letting
 * `created_at` differ per row would pass against the old code and prove
 * nothing.
 */
describe.skipIf(!RUN_DB)('paging the merchant portal (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const CATALOGUE = 12;
  const PAGE = 4;

  let merchantId: string;
  let storeId: string;
  let ids: string[];

  beforeAll(async () => {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Merchant paging ${id.slice(0, 8)}`,
        legal_name: 'Merchant Paging Ltd',
        email: `mpaging+${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      },
      ACTOR,
    );
    merchantId = merchant.id;
    const store = await stores.create(
      {
        merchant_id: merchantId,
        slug: `mpaging-${id.slice(0, 8)}`,
        display_name: 'Merchant Paging',
      },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchantId, ACTOR);
    await merchants.transition(merchantId, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    storeId = store.id;

    ids = [];
    for (let n = 0; n < CATALOGUE; n += 1) {
      const product = await products.create(
        {
          store_id: storeId,
          title: `Merchant paged item ${String(n).padStart(2, '0')}`,
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

    // One timestamp across every row, the way a seed or bulk import leaves it.
    await db.execute(
      sql`UPDATE products SET created_at = '2026-02-02T00:00:00Z' WHERE store_id = ${storeId}`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function pageOf(offset: number): Promise<string[]> {
    const rows = await products.list({ merchant_id: merchantId, limit: PAGE, offset });
    return rows.map((r) => r.id);
  }

  it('shows every product exactly once across the pages', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < CATALOGUE; offset += PAGE) {
      seen.push(...(await pageOf(offset)));
    }
    expect(seen).toHaveLength(CATALOGUE);
    expect(new Set(seen).size).toBe(CATALOGUE);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('returns the same page when asked for it twice', async () => {
    expect(await pageOf(PAGE)).toEqual(await pageOf(PAGE));
  });

  it('runs off the end cleanly rather than wrapping', async () => {
    expect(await pageOf(CATALOGUE)).toEqual([]);
  });

  /**
   * Why the tiebreak is not decoration.
   *
   * The three cases above are regression guards: with twelve rows the planner
   * always picks the same cheap path, so they pass with or without the fix.
   * What follows is the actual demonstration — the same query, the same data,
   * and only the plan Postgres is allowed to choose differs, which in
   * production changes on its own as a table grows.
   */
  it('proves ties really do page differently, which is the whole reason', async () => {
    await db.execute(sql`
      CREATE TEMP TABLE merchant_tie_demo AS
        SELECT gen_random_uuid() AS id, TIMESTAMPTZ '2026-02-02' AS created_at
        FROM generate_series(1, 20000)`);
    await db.execute(sql`ANALYZE merchant_tie_demo`);

    async function plan(kind: 'serial' | 'parallel'): Promise<void> {
      await db.execute(
        kind === 'serial'
          ? sql`SET max_parallel_workers_per_gather = 0; SET work_mem = '128MB'`
          : sql`SET max_parallel_workers_per_gather = 4;
                SET parallel_setup_cost = 0;
                SET parallel_tuple_cost = 0;
                SET min_parallel_table_scan_size = 0;
                SET work_mem = '64kB'`,
      );
    }

    async function page(kind: 'serial' | 'parallel'): Promise<string[]> {
      await plan(kind);
      const rows = await db.execute(
        sql`SELECT id::text FROM merchant_tie_demo ORDER BY created_at DESC LIMIT 5 OFFSET 10000`,
      );
      return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    }

    const serial = await page('serial');
    const parallel = await page('parallel');

    // Identical query, identical data, and not one row in common. Each of
    // those five products sits on page N under one plan and on a different
    // page under the other — listed twice to one request and never to the
    // next.
    expect(serial).toHaveLength(5);
    expect(serial.filter((id) => parallel.includes(id))).toEqual([]);

    // With the tiebreak this fix adds, the same two plans agree exactly.
    async function tiebroken(kind: 'serial' | 'parallel'): Promise<string[]> {
      await plan(kind);
      const rows = await db.execute(
        sql`SELECT id::text FROM merchant_tie_demo
            ORDER BY created_at DESC, id DESC LIMIT 5 OFFSET 10000`,
      );
      return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    }

    expect(await tiebroken('serial')).toEqual(await tiebroken('parallel'));
  });
});
