import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { eq } from 'drizzle-orm';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { StoreNotFoundError } from '../stores/errors';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { NotPurchasableError } from '../orders/errors';
import { InventoryService } from './inventory.service';
import { ProductsService } from './products.service';
import { MediaService } from './media';
import { StorefrontService } from './storefront.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * A seller who is not trading must not be able to sell.
 *
 * This was broken, live, and found while scoping merchant self-signup. Only
 * `stores.status` gated the public surface; `merchants.status` was checked
 * nowhere on it, and checkout re-verified the variant and the product but
 * neither the store nor the seller. So suspending a merchant for fraud wrote
 * one column and stopped nothing: their shopfront kept answering 200, their
 * goods stayed listed, and a GHS 1,200 order went through against them.
 *
 * The public read surface had no integration spec of its own, which is exactly
 * how a missing join hides — every unit test builds the rows it wants to see.
 * This one puts two sellers in Postgres and changes one of their statuses.
 */
describe.skipIf(!RUN_DB)('a seller who is not trading cannot sell (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const applications = new ApplicationsService(db, audit);
  const plans = new CustomerPlansService(db, audit);
  const cart = new CartService(db);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit);
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  interface Seller {
    merchantId: string;
    storeId: string;
    slug: string;
    productId: string;
    variantId: string;
    title: string;
  }

  let seller: Seller;

  async function newSeller(): Promise<Seller> {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Live Co ${id.slice(0, 8)}`,
        legal_name: 'Live Co Ltd',
        email: `live+${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      },
      ACTOR,
    );
    // Created merchants land in pending_kyc; trading requires activation.
    // A merchant's first activation needs approved KYC documents behind it;
    // this fixture's subject is not KYC, so it satisfies the requirement.
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    const slug = `live-${id.slice(0, 8)}`;
    const store = await stores.create(
      { merchant_id: merchant.id, slug, display_name: 'Live Co' },
      ACTOR,
    );
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    const title = `Kettle ${id.slice(0, 8)}`;
    const product = await products.create(
      {
        store_id: store.id,
        title,
        base_price_pesewas: 120_000,
        status: 'active',
        variants: [{ sku: `SKU-${id.slice(0, 8)}`, quantity_available: 10 }],
      },
      ACTOR,
    );
    return {
      merchantId: merchant.id,
      storeId: store.id,
      slug,
      productId: product.id,
      variantId: product.variants[0]!.id,
      title,
    };
  }

  async function freshCustomer(): Promise<string> {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Adwoa',
        last_name: 'Asante',
        email: `live+${id}@fixture.local`,
        phone: `+2335${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning();
    return rows[0]!.id;
  }

  /** Was this seller's product returned by a public browse? */
  async function listedPublicly(s: Seller): Promise<boolean> {
    const page = await storefront.browse({ store_slug: s.slug, limit: 50, offset: 0 });
    return page.rows.some((r) => r.id === s.productId);
  }

  /** Try to buy from this seller, reporting whether checkout allowed it. */
  async function canCheckOut(s: Seller): Promise<boolean> {
    const customerId = await freshCustomer();
    await cart.addItem(customerId, { variant_id: s.variantId, quantity: 1 });
    try {
      await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
      return true;
    } catch (err) {
      if (err instanceof NotPurchasableError) return false;
      throw err;
    }
  }

  beforeAll(async () => {
    seller = await newSeller();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sells while the seller is active — the baseline everything else is measured against', async () => {
    expect(await listedPublicly(seller)).toBe(true);
    expect(await storefront.store(seller.slug)).toMatchObject({ slug: seller.slug });
    expect(await canCheckOut(seller)).toBe(true);
  });

  describe.each([
    ['suspended', 'suspend'],
    ['offboarded', 'offboard'],
  ] as const)('once the merchant is %s', (expectedStatus, event) => {
    let closed: Seller;

    beforeAll(async () => {
      closed = await newSeller();
      const merchant = await merchants.transition(
        closed.merchantId,
        { event, reason: 'integration test' },
        ACTOR,
      );
      expect(merchant.status).toBe(expectedStatus);
    });

    it('drops their goods out of the storefront', async () => {
      expect(await listedPublicly(closed)).toBe(false);
    });

    it('stops answering for their shopfront', async () => {
      await expect(storefront.store(closed.slug)).rejects.toThrow(StoreNotFoundError);
    });

    it('refuses their product on the product page', async () => {
      await expect(storefront.product(closed.productId)).rejects.toThrow();
    });

    /**
     * The one that actually protects money. A listing that lingers in a cache
     * is a cosmetic problem; taking a customer's cash for a merchant you have
     * suspended is not.
     */
    it('refuses checkout, even from a cart built before the suspension', async () => {
      const customerId = await freshCustomer();
      await cart.addItem(customerId, { variant_id: closed.variantId, quantity: 1 });
      await expect(orders.checkout(customerId, { payment_type: 'full' }, ACTOR)).rejects.toThrow(
        NotPurchasableError,
      );
    });

    it('leaves the store row itself alone — this is a read-time gate', async () => {
      // Suspension is recorded on the merchant. The store is not rewritten, so
      // reactivating restores trading without having to remember what the
      // store's status used to be.
      const store = await stores.get(closed.storeId);
      expect(store.status).toBe('active');
    });
  });

  it('will not sell for a merchant still pending KYC', async () => {
    // The state every merchant is created in, and the one self-signup will
    // land in. An active store under an unverified merchant must not trade.
    const pending = await newSeller();
    await db
      .update(schema.merchants)
      .set({ status: 'pending_kyc' })
      .where(eq(schema.merchants.id, pending.merchantId));

    expect(await listedPublicly(pending)).toBe(false);
    expect(await canCheckOut(pending)).toBe(false);
  });

  it('trades again after reactivation, with no other change', async () => {
    const recovered = await newSeller();
    await merchants.transition(recovered.merchantId, { event: 'suspend' }, ACTOR);
    expect(await listedPublicly(recovered)).toBe(false);

    await merchants.transition(recovered.merchantId, { event: 'reactivate' }, ACTOR);
    expect(await listedPublicly(recovered)).toBe(true);
    expect(await canCheckOut(recovered)).toBe(true);
  });

  it('still refuses a live merchant whose store is closed', async () => {
    // The half that already worked, kept honest: the seller gate is additional
    // to the store gate, not a replacement for it.
    const shut = await newSeller();
    await stores.transition(shut.storeId, { event: 'suspend' }, ACTOR);

    expect(await listedPublicly(shut)).toBe(false);
    expect(await canCheckOut(shut)).toBe(false);
  });
});
