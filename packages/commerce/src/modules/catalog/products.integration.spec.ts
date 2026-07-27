import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@installment/db';
import { AuditLogger, MerchantsService, SYSTEM_ACTORS } from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from './products.service';
import { ProductConflictError, ProductNotFoundError, ProductValidationError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('ProductsService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const products = new ProductsService(db, audit);
  const stores = new StoresService(db, audit);
  const merchants = new MerchantsService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let storeId: string;
  let planTemplateId: string;

  beforeAll(async () => {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Prod Co ${id}`,
        legal_name: `Prod Co Ltd ${id}`,
        email: `prod+${id}@example.gh`,
        phone: '+233244111111',
      },
      SYSTEM_ACTOR,
    );
    const store = await stores.create(
      {
        merchant_id: merchant.id,
        slug: `prod-store-${id.slice(0, 8)}`,
        display_name: 'Prod Store',
      },
      SYSTEM_ACTOR,
    );
    storeId = store.id;

    const [pt] = await db
      .insert(schema.plan_templates)
      .values({
        name: `Test BNPL ${id}`,
        business_model: 'bnpl',
        number_of_installments: 3,
        installment_frequency_days: 30,
        min_amount_pesewas: 1,
        max_amount_pesewas: 100_000_000,
      })
      .returning({ id: schema.plan_templates.id });
    planTemplateId = pt!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const sku = () => `SKU-${randomUUID().slice(0, 8)}`;

  it('creates a product with variants, images, inventory and plan offers', async () => {
    const product = await products.create(
      {
        store_id: storeId,
        title: 'iPhone 15',
        description: 'A phone',
        base_price_pesewas: 1_500_000,
        status: 'active',
        variants: [{ sku: sku(), quantity_available: 7 }],
        images: [{ storage_key: 'img/1.jpg', position: 0 }],
        plan_template_ids: [planTemplateId],
      },
      SYSTEM_ACTOR,
    );

    expect(product.merchant_id).toBeTruthy();
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]!.inventory?.quantity_available).toBe(7);
    expect(product.images).toHaveLength(1);
    expect(product.plan_template_ids).toEqual([planTemplateId]);
    // internal FTS column is never surfaced
    expect('search_tsv' in product).toBe(false);
  });

  it('rejects a duplicate SKU within one product', async () => {
    const dup = sku();
    await expect(
      products.create(
        {
          store_id: storeId,
          title: 'Dup',
          base_price_pesewas: 100,
          variants: [{ sku: dup }, { sku: dup }],
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ProductConflictError);
  });

  it('rejects an unknown plan_template_id', async () => {
    await expect(
      products.create(
        {
          store_id: storeId,
          title: 'X',
          base_price_pesewas: 100,
          plan_template_ids: [randomUUID()],
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ProductValidationError);
  });

  it('rejects an unknown store', async () => {
    await expect(
      products.create(
        { store_id: randomUUID(), title: 'X', base_price_pesewas: 100 },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ProductValidationError);
  });

  it('full-text search finds an active product and excludes drafts', async () => {
    const token = `Zephyr${randomUUID().slice(0, 8)}`;
    const active = await products.create(
      { store_id: storeId, title: `${token} Widget`, base_price_pesewas: 500, status: 'active' },
      SYSTEM_ACTOR,
    );
    await products.create(
      { store_id: storeId, title: `${token} Hidden`, base_price_pesewas: 500, status: 'draft' },
      SYSTEM_ACTOR,
    );

    const results = await products.search({ q: token });
    expect(results.map((r) => r.id)).toContain(active.id);
    expect(results.every((r) => r.status === 'active')).toBe(true);
  });

  it('setPlanOffers replaces the offer set', async () => {
    const product = await products.create(
      { store_id: storeId, title: 'Offers', base_price_pesewas: 500 },
      SYSTEM_ACTOR,
    );
    expect(
      await products.setPlanOffers(
        product.id,
        { plan_template_ids: [planTemplateId] },
        SYSTEM_ACTOR,
      ),
    ).toEqual([planTemplateId]);
    expect(
      await products.setPlanOffers(product.id, { plan_template_ids: [] }, SYSTEM_ACTOR),
    ).toEqual([]);
    expect((await products.getWithDetails(product.id)).plan_template_ids).toEqual([]);
  });

  it('throws for an unknown product id', async () => {
    await expect(products.getWithDetails(randomUUID())).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });
});
