import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger, MerchantsService, SYSTEM_ACTORS } from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from './products.service';
import { ProductConflictError, ProductNotFoundError, ProductValidationError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('ProductsService (integration)', () => {
  const { db, pool } = createTestDb();
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

  /**
   * The variant stock the seller's catalogue card draws, and the filter behind
   * its "Needs restock" chip.
   *
   * A fresh merchant per test for the same reason as the summary block below:
   * these read a whole catalogue, and the file's shared store is whatever the
   * tests above happened to create.
   */
  describe('catalogue for the seller app', () => {
    async function freshShop() {
      const id = randomUUID();
      const merchant = await merchants.create(
        {
          business_name: `Cat Co ${id}`,
          legal_name: `Cat Co Ltd ${id}`,
          email: `cat+${id}@example.gh`,
          phone: '+233244333333',
        },
        SYSTEM_ACTOR,
      );
      const store = await stores.create(
        { merchant_id: merchant.id, slug: `cat-${id.slice(0, 8)}`, display_name: 'Cat Store' },
        SYSTEM_ACTOR,
      );
      return { merchantId: merchant.id, storeId: store.id };
    }

    const sku = () => `SKU-${randomUUID().slice(0, 8)}`;

    it('brings every active variant back with its stock, in one call', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Ankara Wrap Dress',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: sku(), option_values: { size: 'S' }, quantity_available: 24 },
            { sku: sku(), option_values: { size: 'M' }, quantity_available: 0 },
          ],
        },
        SYSTEM_ACTOR,
      );

      const byProduct = await products.variantsForProducts([created.id]);
      const variants = byProduct.get(created.id) ?? [];

      expect(variants).toHaveLength(2);
      expect(variants.map((v) => v.option_values)).toEqual([{ size: 'S' }, { size: 'M' }]);
      expect(variants.map((v) => v.quantity_available)).toEqual([24, 0]);
    });

    it('reads a variant with no inventory row as none on the shelf, not as unknown', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'No stock row',
          base_price_pesewas: 1_000,
          status: 'active',
          // No `quantity_available`, so no `inventory` row is written at all.
          variants: [{ sku: sku() }],
        },
        SYSTEM_ACTOR,
      );

      const variants = (await products.variantsForProducts([created.id])).get(created.id) ?? [];

      expect(variants).toHaveLength(1);
      expect(variants[0]?.quantity_available).toBe(0);
      expect(variants[0]?.restock_threshold).toBe(0);
    });

    it('leaves a retired variant out of the card', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Retired size',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 5 },
            { sku: sku(), quantity_available: 9 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await db
        .update(schema.product_variants)
        .set({ is_active: false })
        .where(eq(schema.product_variants.id, created.variants[0]!.id));

      const variants = (await products.variantsForProducts([created.id])).get(created.id) ?? [];

      expect(variants).toHaveLength(1);
      expect(variants[0]?.id).toBe(created.variants[1]!.id);
    });

    it('keeps the sizes in the order the seller typed them', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Sized',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), option_values: { size: 'S' } },
            { sku: sku(), option_values: { size: 'M' } },
            { sku: sku(), option_values: { size: 'L' } },
            { sku: sku(), option_values: { size: 'XL' } },
          ],
        },
        SYSTEM_ACTOR,
      );

      // Every one of these shares `created_at` — they go in inside one
      // transaction — so before 0021 the only stable ordering was the primary
      // key, and a seller who typed S, M, L, XL got their chips back in
      // whatever order four random uuids sorted in.
      const listed = (await products.variantsForProducts([created.id])).get(created.id) ?? [];
      expect(listed.map((v) => v.option_values)).toEqual([
        { size: 'S' },
        { size: 'M' },
        { size: 'L' },
        { size: 'XL' },
      ]);

      // The detail read and the shopper's storefront read the same order.
      const detail = await products.getWithDetails(created.id);
      expect(detail.variants.map((v) => v.option_values)).toEqual([
        { size: 'S' },
        { size: 'M' },
        { size: 'L' },
        { size: 'XL' },
      ]);
    });

    it('puts a later variant after the ones already there, not on top of one', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Growing range',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), option_values: { size: 'S' } },
            { sku: sku(), option_values: { size: 'M' } },
          ],
        },
        SYSTEM_ACTOR,
      );
      await products.addVariant(
        created.id,
        { sku: sku(), option_values: { size: 'L' } },
        SYSTEM_ACTOR,
      );

      const listed = (await products.variantsForProducts([created.id])).get(created.id) ?? [];
      expect(listed.map((v) => v.option_values)).toEqual([
        { size: 'S' },
        { size: 'M' },
        { size: 'L' },
      ]);
    });

    it('orders a product’s variants the same way twice', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Four sizes',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), option_values: { size: 'S' } },
            { sku: sku(), option_values: { size: 'M' } },
            { sku: sku(), option_values: { size: 'L' } },
            { sku: sku(), option_values: { size: 'XL' } },
          ],
        },
        SYSTEM_ACTOR,
      );

      // One INSERT, so all four share `created_at` to the microsecond. Without
      // the id tiebreak the size chips would reorder between reads.
      const first = (await products.variantsForProducts([created.id])).get(created.id) ?? [];
      const second = (await products.variantsForProducts([created.id])).get(created.id) ?? [];
      expect(first.map((v) => v.id)).toEqual(second.map((v) => v.id));
      expect(first).toHaveLength(4);
    });

    it('returns an empty map for no products', async () => {
      expect((await products.variantsForProducts([])).size).toBe(0);
    });

    it('lists a product once when several of its sizes are empty', async () => {
      const shop = await freshShop();
      await products.create(
        {
          store_id: shop.storeId,
          title: 'Two sizes gone',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 4 },
            { sku: sku(), quantity_available: 0 },
            { sku: sku(), quantity_available: 0 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await products.create(
        {
          store_id: shop.storeId,
          title: 'Fully stocked',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [{ sku: sku(), quantity_available: 7 }],
        },
        SYSTEM_ACTOR,
      );

      const rows = await products.list({ merchant_id: shop.merchantId, needs_restock: true });

      // Once, not twice: a join would have returned the product per empty size.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('Two sizes gone');
    });

    it('does not ask a seller to restock a variant they have retired', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Retired and empty',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 0 },
            { sku: sku(), quantity_available: 3 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await db
        .update(schema.product_variants)
        .set({ is_active: false })
        .where(eq(schema.product_variants.id, created.variants[0]!.id));

      expect(await products.list({ merchant_id: shop.merchantId, needs_restock: true })).toEqual(
        [],
      );
    });
  });

  /**
   * The catalogue counts the seller app's home screen acts on.
   *
   * A fresh merchant per test, not the file's shared store: these are counts
   * over a whole catalogue, and a shared store would make every assertion a
   * function of how many products the tests above happened to create.
   */
  describe('summaryForMerchant', () => {
    async function freshShop() {
      const id = randomUUID();
      const merchant = await merchants.create(
        {
          business_name: `Sum Co ${id}`,
          legal_name: `Sum Co Ltd ${id}`,
          email: `sum+${id}@example.gh`,
          phone: '+233244222222',
        },
        SYSTEM_ACTOR,
      );
      const store = await stores.create(
        { merchant_id: merchant.id, slug: `sum-${id.slice(0, 8)}`, display_name: 'Sum Store' },
        SYSTEM_ACTOR,
      );
      return { merchantId: merchant.id, storeId: store.id };
    }

    const sku = () => `SKU-${randomUUID().slice(0, 8)}`;

    it('is all zeroes for a shop with nothing in it', async () => {
      const { merchantId } = await freshShop();

      expect(await products.summaryForMerchant(merchantId)).toEqual({
        products: 0,
        liveProducts: 0,
        variants: 0,
        outOfStockVariants: 0,
        lowStockVariants: 0,
      });
    });

    it('counts products, live products and variants', async () => {
      const shop = await freshShop();
      await products.create(
        {
          store_id: shop.storeId,
          title: 'Live dress',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 5 },
            { sku: sku(), quantity_available: 2 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await products.create(
        {
          store_id: shop.storeId,
          title: 'Draft blazer',
          base_price_pesewas: 64_000,
          status: 'draft',
          variants: [{ sku: sku(), quantity_available: 1 }],
        },
        SYSTEM_ACTOR,
      );

      expect(await products.summaryForMerchant(shop.merchantId)).toMatchObject({
        products: 2,
        liveProducts: 1,
        variants: 3,
        outOfStockVariants: 0,
      });
    });

    it('counts a variant with nothing on the shelf as out of stock', async () => {
      const shop = await freshShop();
      await products.create(
        {
          store_id: shop.storeId,
          title: 'Part-stocked dress',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 24 },
            { sku: sku(), quantity_available: 0 },
            { sku: sku(), quantity_available: 0 },
          ],
        },
        SYSTEM_ACTOR,
      );

      const summary = await products.summaryForMerchant(shop.merchantId);

      expect(summary.variants).toBe(3);
      expect(summary.outOfStockVariants).toBe(2);
      // Zero is out of stock, never also low: counting it twice would report
      // the same problem to the seller as two problems.
      expect(summary.lowStockVariants).toBe(0);
    });

    it('counts a variant at or under its own threshold as low, but not at zero', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Thresholded',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 3 },
            { sku: sku(), quantity_available: 40 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await db
        .update(schema.inventory)
        .set({ restock_threshold: 5 })
        .where(eq(schema.inventory.variant_id, created.variants[0]!.id));

      const summary = await products.summaryForMerchant(shop.merchantId);

      expect(summary.lowStockVariants).toBe(1);
      expect(summary.outOfStockVariants).toBe(0);
    });

    it('ignores a retired variant — telling a seller to restock it is noise', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Retired size',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: sku(), quantity_available: 0 },
            { sku: sku(), quantity_available: 9 },
          ],
        },
        SYSTEM_ACTOR,
      );
      await db
        .update(schema.product_variants)
        .set({ is_active: false })
        .where(eq(schema.product_variants.id, created.variants[0]!.id));

      const summary = await products.summaryForMerchant(shop.merchantId);

      expect(summary.variants).toBe(1);
      expect(summary.outOfStockVariants).toBe(0);
    });

    it('ignores a deleted product', async () => {
      const shop = await freshShop();
      const created = await products.create(
        {
          store_id: shop.storeId,
          title: 'Gone',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [{ sku: sku(), quantity_available: 0 }],
        },
        SYSTEM_ACTOR,
      );
      await db
        .update(schema.products)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(schema.products.id, created.id));

      expect(await products.summaryForMerchant(shop.merchantId)).toMatchObject({
        products: 0,
        variants: 0,
        outOfStockVariants: 0,
      });
    });

    it('never counts another merchant’s catalogue', async () => {
      const mine = await freshShop();
      const theirs = await freshShop();
      await products.create(
        {
          store_id: theirs.storeId,
          title: 'Not mine',
          base_price_pesewas: 1_000,
          status: 'active',
          variants: [{ sku: sku(), quantity_available: 0 }],
        },
        SYSTEM_ACTOR,
      );

      expect(await products.summaryForMerchant(mine.merchantId)).toMatchObject({
        products: 0,
        variants: 0,
        outOfStockVariants: 0,
      });
    });
  });
});
