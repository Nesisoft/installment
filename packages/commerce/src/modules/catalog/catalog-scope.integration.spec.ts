import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger, MerchantsService, SYSTEM_ACTORS } from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { InventoryService } from './inventory.service';
import { ProductsService } from './products.service';
import { ProductNotFoundError, ProductValidationError, VariantNotFoundError } from './errors';
import { StoreNotFoundError } from '../stores/errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Tenant isolation for the merchant catalogue surface.
 *
 * Product writes used to live only behind `catalog:write`, where every caller
 * is trusted with every store. Opening them to sellers means each one has to
 * refuse its neighbour's rows, and the only way to know a WHERE clause actually
 * filters is to run it against Postgres with two merchants' rows in the table —
 * a mocked query builder returns whatever it was told to.
 *
 * Every refusal below is a *not found*, never a *forbidden*: 403 confirms the
 * row exists, and confirming which uuids are real products turns enumeration
 * into a slow read of a competitor's unreleased catalogue.
 */
describe.skipIf(!RUN_DB)('Merchant catalogue scoping (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const stores = new StoresService(db, audit);
  const merchants = new MerchantsService(db, audit);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  interface Seller {
    merchantId: string;
    storeId: string;
    productId: string;
    variantId: string;
  }

  let mine: Seller;
  let theirs: Seller;

  async function seller(label: string): Promise<Seller> {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `${label} ${id.slice(0, 8)}`,
        legal_name: `${label} Ltd`,
        email: `${label.toLowerCase()}+${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      },
      ACTOR,
    );
    const store = await stores.create(
      {
        merchant_id: merchant.id,
        slug: `${label.toLowerCase()}-${id.slice(0, 8)}`,
        display_name: label,
      },
      ACTOR,
    );
    const product = await products.create(
      {
        store_id: store.id,
        title: `${label} kettle`,
        base_price_pesewas: 12_000,
        status: 'active',
        variants: [{ sku: `SKU-${id.slice(0, 8)}`, quantity_available: 5 }],
      },
      ACTOR,
    );
    return {
      merchantId: merchant.id,
      storeId: store.id,
      productId: product.id,
      variantId: product.variants[0]!.id,
    };
  }

  beforeAll(async () => {
    mine = await seller('Mine');
    theirs = await seller('Theirs');
  });

  afterAll(async () => {
    await pool.end();
  });

  // --- reads ----------------------------------------------------------------

  it('reads my own product when scoped to me', async () => {
    const found = await products.getWithDetails(mine.productId, { merchantId: mine.merchantId });
    expect(found.id).toBe(mine.productId);
    expect(found.merchant_id).toBe(mine.merchantId);
  });

  it('refuses another merchant’s product as not found', async () => {
    await expect(
      products.getWithDetails(theirs.productId, { merchantId: mine.merchantId }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it('lists only my own products', async () => {
    const rows = await products.list({ merchant_id: mine.merchantId });
    expect(rows.map((r) => r.id)).toContain(mine.productId);
    expect(rows.map((r) => r.id)).not.toContain(theirs.productId);
  });

  // --- writes ---------------------------------------------------------------

  it('edits my own product and refuses theirs', async () => {
    const updated = await products.update(
      mine.productId,
      { title: 'Mine kettle, renamed' },
      ACTOR,
      { merchantId: mine.merchantId },
    );
    expect(updated.title).toBe('Mine kettle, renamed');

    await expect(
      products.update(theirs.productId, { title: 'hijacked' }, ACTOR, {
        merchantId: mine.merchantId,
      }),
    ).rejects.toThrow(ProductNotFoundError);

    // And the refusal left no mark: an UPDATE that filtered correctly wrote
    // nothing, rather than writing and then complaining.
    const untouched = await products.get(theirs.productId);
    expect(untouched.title).not.toBe('hijacked');
  });

  it('refuses to add a variant to another merchant’s product', async () => {
    await expect(
      products.addVariant(theirs.productId, { sku: `X-${randomUUID().slice(0, 8)}` }, ACTOR, {
        merchantId: mine.merchantId,
      }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it('refuses to attach a photo to another merchant’s product', async () => {
    await expect(
      products.addImage(theirs.productId, { storage_key: 'public/products/x.jpg' }, ACTOR, {
        merchantId: mine.merchantId,
      }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it('refuses to change the plan offers on another merchant’s product', async () => {
    await expect(
      products.setPlanOffers(theirs.productId, { plan_template_ids: [] }, ACTOR, {
        merchantId: mine.merchantId,
      }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  /**
   * The one that is not a uuid guess: `store_id` is a field the caller sends, so
   * without scoping the store lookup a seller could list a product straight into
   * a competitor's shop — and it would look, to every shopper, like the
   * competitor was selling it.
   */
  it('refuses to create a product in another merchant’s store', async () => {
    await expect(
      products.create(
        {
          store_id: theirs.storeId,
          title: 'Planted',
          base_price_pesewas: 1_000,
        },
        ACTOR,
        { merchantId: mine.merchantId },
      ),
    ).rejects.toThrow(ProductValidationError);
  });

  // --- stock ----------------------------------------------------------------

  it('sets stock on my own variant and refuses theirs', async () => {
    const set = await inventory.setStock(
      mine.variantId,
      { quantity_available: 42 },
      { merchantId: mine.merchantId },
    );
    expect(set.quantity_available).toBe(42);

    await expect(
      inventory.setStock(
        theirs.variantId,
        { quantity_available: 0 },
        {
          merchantId: mine.merchantId,
        },
      ),
    ).rejects.toThrow(VariantNotFoundError);

    const untouched = await inventory.getByVariant(theirs.variantId);
    expect(untouched.quantity_available).toBe(5);
  });

  it('adjusts stock on my own variant and refuses theirs', async () => {
    const adjusted = await inventory.adjust(
      mine.variantId,
      { delta: -2 },
      {
        merchantId: mine.merchantId,
      },
    );
    expect(adjusted.quantity_available).toBe(40);

    await expect(
      inventory.adjust(theirs.variantId, { delta: -1 }, { merchantId: mine.merchantId }),
    ).rejects.toThrow(VariantNotFoundError);
  });

  it('refuses to read stock on another merchant’s variant', async () => {
    await expect(
      inventory.getByVariant(theirs.variantId, { merchantId: mine.merchantId }),
    ).rejects.toThrow(VariantNotFoundError);
  });

  // --- the shopfront --------------------------------------------------------

  it('edits my own store when scoped to me', async () => {
    const updated = await stores.update(mine.storeId, { display_name: 'Mine, renamed' }, ACTOR, {
      merchantId: mine.merchantId,
    });

    expect(updated.display_name).toBe('Mine, renamed');
  });

  it('refuses another merchant’s store as not found, and leaves it untouched', async () => {
    const before = await stores.get(theirs.storeId);

    await expect(
      stores.update(theirs.storeId, { display_name: 'hijacked' }, ACTOR, {
        merchantId: mine.merchantId,
      }),
    ).rejects.toThrow(StoreNotFoundError);

    // An UPDATE that filtered correctly wrote nothing, rather than writing and
    // then complaining about it.
    expect((await stores.get(theirs.storeId)).display_name).toBe(before.display_name);
  });

  // --- the admin surface is deliberately unscoped ----------------------------

  it('still lets an unscoped caller reach every merchant’s catalogue', async () => {
    // Back-office staff edit any store's products; passing no scope must add
    // nothing to the WHERE at all, or this change would have quietly broken
    // /admin/products for everyone.
    expect((await products.getWithDetails(theirs.productId)).id).toBe(theirs.productId);
    expect((await inventory.getByVariant(theirs.variantId)).variant_id).toBe(theirs.variantId);
    expect((await stores.update(theirs.storeId, { about: 'set by staff' }, ACTOR)).about).toBe(
      'set by staff',
    );
  });
});
