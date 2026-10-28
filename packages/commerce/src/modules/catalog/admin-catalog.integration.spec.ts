import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  AuditLogger,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from './products.service';
import { MediaService } from './media';
import { AdminCatalogService } from './admin-catalog.service';
import { ProductConflictError, ProductTakenDownError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Moderating the catalogue: taking a listing down so that it stays down, and
 * the reads staff judge listings and shops by.
 */
describe.skipIf(!RUN_DB)('Catalogue moderation (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const catalog = new AdminCatalogService(db, products, new MediaService('https://cdn.test/media'));
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
  const STAFF = { actorId: randomUUID(), actorType: 'admin' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function shop(name: string, live = true) {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `${name} ${id}`,
        legal_name: `${name} Ltd ${id}`,
        email: `cat+${id}@example.gh`,
        phone: '+233244555555',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `c-${id.slice(0, 8)}`, display_name: `${name} store` },
      ACTOR,
    );
    if (live) {
      await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
      await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
      await stores.transition(store.id, { event: 'activate' }, ACTOR);
    }
    return { merchantId: merchant.id, storeId: store.id, merchantName: merchant.business_name };
  }

  async function listing(storeId: string, title: string, status: 'draft' | 'active' = 'active') {
    return products.create(
      {
        store_id: storeId,
        title,
        base_price_pesewas: 12_000,
        status,
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 7 },
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 3 },
        ],
        images: [{ storage_key: 'products/kente-1.jpg', position: 0 }],
      },
      ACTOR,
    );
  }

  it('takes a listing down and keeps it down, whatever the seller does', async () => {
    const { merchantId, storeId } = await shop('Takedown');
    const fake = await listing(storeId, 'Designer handbag (replica)');

    const down = await products.takeDown(fake.id, { reason: 'Counterfeit brand' }, STAFF);
    expect(down).toMatchObject({
      status: 'archived',
      taken_down_reason: 'Counterfeit brand',
      taken_down_from_status: 'active',
      taken_down_by: STAFF.actorId,
    });

    // The seller cannot put it back on sale…
    await expect(
      products.update(fake.id, { status: 'active' }, ACTOR, { merchantId }),
    ).rejects.toBeInstanceOf(ProductTakenDownError);
    // …nor can anyone else by changing the status.
    await expect(products.update(fake.id, { status: 'draft' }, STAFF)).rejects.toBeInstanceOf(
      ProductTakenDownError,
    );
    // But they can fix the listing, which is how one gets reinstated.
    const fixed = await products.update(fake.id, { title: 'Leather handbag' }, ACTOR, {
      merchantId,
    });
    expect(fixed).toMatchObject({ title: 'Leather handbag', status: 'archived' });

    await expect(products.takeDown(fake.id, { reason: 'again' }, STAFF)).rejects.toBeInstanceOf(
      ProductConflictError,
    );

    const [event] = await db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.event_type, 'product.taken_down'))
      .then((rows) => rows.filter((r) => r.entity_id === fake.id));
    expect(event).toMatchObject({
      from_state: 'active',
      to_state: 'archived',
      reason: 'Counterfeit brand',
    });
  });

  it('lifts a takedown back to the status the listing was taken from', async () => {
    const { storeId } = await shop('Lift');
    const live = await listing(storeId, 'Kente stole');
    const draft = await listing(storeId, 'Smock, unfinished', 'draft');
    await products.takeDown(live.id, { reason: 'Complaint under review' }, STAFF);
    await products.takeDown(draft.id, { reason: 'Complaint under review' }, STAFF);

    expect(await products.liftTakedown(live.id, STAFF)).toMatchObject({
      status: 'active',
      taken_down_at: null,
      taken_down_reason: null,
    });
    // A draft taken down goes back to being a draft, not onto the storefront.
    expect((await products.liftTakedown(draft.id, STAFF)).status).toBe('draft');
    await expect(products.liftTakedown(live.id, STAFF)).rejects.toBeInstanceOf(
      ProductConflictError,
    );
  });

  it('lists listings with their shop, seller, picture and stock, and finds them', async () => {
    const { storeId, merchantName } = await shop('Listing');
    const title = `Batik shirt ${randomUUID().slice(0, 6)}`;
    const made = await listing(storeId, title);

    const { rows } = await catalog.listProducts({ q: title });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: made.id,
      store_name: 'Listing store',
      merchant_name: merchantName,
      image_url: 'https://cdn.test/media/products/kente-1.jpg',
      variant_count: 2,
      units_available: 10,
    });

    // A search is a search, not a pattern.
    expect((await catalog.listProducts({ q: '%' })).rows.map((r) => r.id)).not.toContain(made.id);

    await products.takeDown(made.id, { reason: 'Prohibited item' }, STAFF);
    const down = await catalog.listProducts({ taken_down: 'true', limit: 200 });
    expect(down.rows.map((r) => r.id)).toContain(made.id);
    expect(down.rows.every((r) => r.taken_down_at !== null)).toBe(true);
  });

  it('counts listings by status, and those taken down', async () => {
    const before = await catalog.productCounts();
    const { storeId } = await shop('Counts');
    const a = await listing(storeId, 'A');
    await listing(storeId, 'B', 'draft');
    await products.takeDown(a.id, { reason: 'Test' }, STAFF);
    const after = await catalog.productCounts();
    expect(after.all - before.all).toBe(2);
    expect(after.draft - before.draft).toBe(1);
    expect(after.archived - before.archived).toBe(1);
    expect(after.taken_down - before.taken_down).toBe(1);
  });

  it('opens a listing with its pictures resolved and who sells it', async () => {
    const { storeId, merchantId, merchantName } = await shop('Detail');
    const made = await listing(storeId, 'Kaba and slit');
    const detail = await catalog.productDetail(made.id);
    expect(detail.images[0]?.url).toBe('https://cdn.test/media/products/kente-1.jpg');
    expect(detail.variants).toHaveLength(2);
    expect(detail.store).toMatchObject({
      id: storeId,
      display_name: 'Detail store',
      status: 'active',
    });
    expect(detail.merchant).toMatchObject({ id: merchantId, business_name: merchantName });
  });

  it('lists shops awaiting a decision first, with their seller and listings', async () => {
    const pending = await shop('Pending', false);
    const live = await shop('Live');
    await listing(live.storeId, 'Live item');

    const { rows } = await catalog.listStores({ limit: 200 });
    const drafts = rows.filter((r) => r.status === 'draft');
    const firstNonDraft = rows.findIndex((r) => r.status !== 'draft');
    // Every draft comes before every shop already decided.
    expect(rows.slice(0, drafts.length).every((r) => r.status === 'draft')).toBe(true);
    expect(firstNonDraft === -1 || firstNonDraft >= drafts.length).toBe(true);
    expect(rows.find((r) => r.id === pending.storeId)).toMatchObject({
      merchant_name: pending.merchantName,
      merchant_status: 'pending_kyc',
    });
    expect(rows.find((r) => r.id === live.storeId)).toMatchObject({
      product_count: 1,
      active_product_count: 1,
    });

    const counts = await catalog.storeCounts();
    expect(counts.all).toBe(counts.draft + counts.active + counts.suspended);
  });
});
