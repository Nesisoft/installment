import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@installment/db';
import { AuditLogger, MerchantsService, SYSTEM_ACTORS } from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { CartService } from './cart.service';
import { CartItemNotFoundError, NotPurchasableError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('CartService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const audit = new AuditLogger();
  const cart = new CartService(db);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const merchants = new MerchantsService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  let storeId: string;

  beforeAll(async () => {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Cart Co ${id}`,
        legal_name: `Cart Co Ltd ${id}`,
        email: `cart+${id}@example.gh`,
        phone: '+233244333333',
      },
      SYSTEM_ACTOR,
    );
    const store = await stores.create(
      {
        merchant_id: merchant.id,
        slug: `cart-store-${id.slice(0, 8)}`,
        display_name: 'Cart Store',
      },
      SYSTEM_ACTOR,
    );
    storeId = store.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(): Promise<string> {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Kofi',
        last_name: 'Mensah',
        email: `cart+${id}@example.gh`,
        phone: `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  const sku = () => `SKU-${randomUUID().slice(0, 8)}`;

  async function variant(opts: {
    price: number;
    status?: 'draft' | 'active';
    variantPrice?: number | null;
  }): Promise<string> {
    const product = await products.create(
      {
        store_id: storeId,
        title: `P ${randomUUID().slice(0, 8)}`,
        base_price_pesewas: opts.price,
        status: opts.status ?? 'active',
        variants: [
          { sku: sku(), price_pesewas: opts.variantPrice ?? null, quantity_available: 100 },
        ],
      },
      SYSTEM_ACTOR,
    );
    return product.variants[0]!.id;
  }

  it('adds items, snapshots price, increments on repeat, computes subtotal', async () => {
    const customerId = await freshCustomer();
    const v = await variant({ price: 1500 });

    let c = await cart.addItem(customerId, { variant_id: v, quantity: 2 });
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.unit_price_pesewas).toBe(1500);
    expect(c.items[0]!.quantity).toBe(2);
    expect(c.subtotal_pesewas).toBe(3000);

    c = await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    expect(c.items[0]!.quantity).toBe(3);
    expect(c.subtotal_pesewas).toBe(4500);
  });

  it('uses the variant price override when present', async () => {
    const customerId = await freshCustomer();
    const v = await variant({ price: 1000, variantPrice: 800 });
    const c = await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    expect(c.items[0]!.unit_price_pesewas).toBe(800);
  });

  it('sets quantity, removes at 0, and clears', async () => {
    const customerId = await freshCustomer();
    const v = await variant({ price: 1000 });
    await cart.addItem(customerId, { variant_id: v, quantity: 5 });

    let c = await cart.setItemQuantity(customerId, v, { quantity: 2 });
    expect(c.items[0]!.quantity).toBe(2);

    c = await cart.setItemQuantity(customerId, v, { quantity: 0 });
    expect(c.items).toHaveLength(0);

    await cart.addItem(customerId, { variant_id: v, quantity: 1 });
    c = await cart.clear(customerId);
    expect(c.items).toHaveLength(0);
  });

  it('rejects a draft product and an unknown variant', async () => {
    const customerId = await freshCustomer();
    await expect(
      cart.addItem(customerId, {
        variant_id: await variant({ price: 500, status: 'draft' }),
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(NotPurchasableError);
    await expect(
      cart.addItem(customerId, { variant_id: randomUUID(), quantity: 1 }),
    ).rejects.toBeInstanceOf(NotPurchasableError);
  });

  it('setItemQuantity on a missing line throws', async () => {
    const customerId = await freshCustomer();
    await expect(
      cart.setItemQuantity(customerId, randomUUID(), { quantity: 3 }),
    ).rejects.toBeInstanceOf(CartItemNotFoundError);
  });

  it('reuses a single active cart per customer', async () => {
    const customerId = await freshCustomer();
    const c1 = await cart.getOrCreateActiveCart(customerId);
    const c2 = await cart.getOrCreateActiveCart(customerId);
    expect(c2.id).toBe(c1.id);
  });
});
