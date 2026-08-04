import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger, MerchantsService, SYSTEM_ACTORS } from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from './products.service';
import { InventoryService } from './inventory.service';
import { InsufficientStockError, VariantNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('InventoryService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const products = new ProductsService(db, audit);
  const stores = new StoresService(db, audit);
  const merchants = new MerchantsService(db, audit);
  const inventory = new InventoryService(db);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let storeId: string;

  beforeAll(async () => {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Inv Co ${id}`,
        legal_name: `Inv Co Ltd ${id}`,
        email: `inv+${id}@example.gh`,
        phone: '+233244222222',
      },
      SYSTEM_ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `inv-store-${id.slice(0, 8)}`, display_name: 'Inv Store' },
      SYSTEM_ACTOR,
    );
    storeId = store.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function variantWithStock(qty: number): Promise<string> {
    const product = await products.create(
      {
        store_id: storeId,
        title: `Stocked ${randomUUID().slice(0, 8)}`,
        base_price_pesewas: 1000,
        variants: [{ sku: `SKU-${randomUUID().slice(0, 8)}`, quantity_available: qty }],
      },
      SYSTEM_ACTOR,
    );
    return product.variants[0]!.id;
  }

  it('setStock and adjust change available stock', async () => {
    const variantId = await variantWithStock(0);
    expect(
      (await inventory.setStock(variantId, { quantity_available: 10 })).quantity_available,
    ).toBe(10);
    expect((await inventory.adjust(variantId, { delta: 5 })).quantity_available).toBe(15);
    expect((await inventory.adjust(variantId, { delta: -4 })).quantity_available).toBe(11);
  });

  it('adjust cannot drive stock negative', async () => {
    const variantId = await variantWithStock(2);
    await expect(inventory.adjust(variantId, { delta: -5 })).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
  });

  it('reserve moves available→reserved and release moves it back', async () => {
    const variantId = await variantWithStock(10);
    const reserved = await inventory.reserve(variantId, 4);
    expect(reserved.quantity_available).toBe(6);
    expect(reserved.quantity_reserved).toBe(4);

    const released = await inventory.release(variantId, 3);
    expect(released.quantity_available).toBe(9);
    expect(released.quantity_reserved).toBe(1);
  });

  it('reserve rejects when there is not enough available', async () => {
    const variantId = await variantWithStock(2);
    await expect(inventory.reserve(variantId, 5)).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('throws for an unknown variant', async () => {
    await expect(inventory.getByVariant(randomUUID())).rejects.toBeInstanceOf(VariantNotFoundError);
  });
});
