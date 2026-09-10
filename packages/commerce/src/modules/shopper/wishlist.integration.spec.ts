import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import {
  AuditLogger,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { MediaService } from '../catalog/media';
import { StorefrontService } from '../catalog/storefront.service';
import { ProductNotFoundError } from '../catalog/errors';
import { WishlistService } from './wishlist.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Saved items. The first test coverage this module has ever had.
 *
 * `WishlistService` shipped with no spec anywhere and `GET /me/wishlist` had no
 * caller, so nothing exercised it — which let three disagreements sit in it at
 * once. `list` filtered to live listings; `count` was a bare `COUNT(*)` that
 * did not, so the account screen printed one number over a list of a different
 * length, and the mobile client invalidates both queries together so the two
 * were on screen at the same moment. And `list` hydrated its cards from the
 * catalogue's top-100 POPULAR page — an unrelated set — falling back to a full
 * per-id detail fetch for every miss.
 */
describe.skipIf(!RUN_DB)('WishlistService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const wishlist = new WishlistService(db, storefront);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function shopper(): Promise<string> {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Boateng',
        email: `wish-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  async function shop() {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Wish Co ${id.slice(0, 8)}`,
        legal_name: 'Wish Co Ltd',
        email: `wish+${id}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `wish-${id.slice(0, 8)}`, display_name: 'Wish Co' },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id };
  }

  async function listing(storeId: string, title: string): Promise<string> {
    const product = await products.create(
      {
        store_id: storeId,
        title,
        base_price_pesewas: 25_000,
        status: 'active',
        variants: [
          { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 5 },
        ],
      },
      ACTOR,
    );
    return product.id;
  }

  it('gives back a card, not a bare id', async () => {
    const customerId = await shopper();
    const { storeId } = await shop();
    await wishlist.add(customerId, await listing(storeId, 'Kente Scarf'));

    const [card] = await wishlist.list(customerId);

    // The grid needs all of this to draw a tile; a wishlist row carries none of it.
    expect(card).toMatchObject({
      title: 'Kente Scarf',
      base_price_pesewas: 25_000,
      store_display_name: 'Wish Co',
      in_stock: true,
    });
  });

  it('returns newest save first', async () => {
    const customerId = await shopper();
    const { storeId } = await shop();
    const first = await listing(storeId, 'Saved first');
    const second = await listing(storeId, 'Saved second');
    await wishlist.add(customerId, first);
    await wishlist.add(customerId, second);

    const titles = (await wishlist.list(customerId)).map((c) => c.title);

    expect(titles).toEqual(['Saved second', 'Saved first']);
  });

  it('drops a saved item whose seller has been suspended, and says so in the count', async () => {
    // THE ONE THAT MATTERED. `count` was a bare COUNT(*) with no product join
    // while `list` filtered through `liveListingWhere()`, so the account screen
    // said "2 saved" over a list of one — both rendered from the same tap,
    // because the client invalidates ['wishlist'] and ['profile'] together.
    const customerId = await shopper();
    const good = await shop();
    const doomed = await shop();
    await wishlist.add(customerId, await listing(good.storeId, 'Still on sale'));
    await wishlist.add(customerId, await listing(doomed.storeId, 'Seller suspended'));
    expect(await wishlist.count(customerId)).toBe(2);

    await merchants.transition(doomed.merchantId, { event: 'suspend' }, ACTOR);

    const rows = await wishlist.list(customerId);
    expect(rows.map((r) => r.title)).toEqual(['Still on sale']);
    expect(await wishlist.count(customerId)).toBe(rows.length);
  });

  it('keeps the heart filled for a save the list will not show', async () => {
    // `ids` deliberately does NOT filter: it answers "did I save this?" on a
    // product page the shopper already has open, and that page can be open for
    // a listing that has since been archived. Emptying the heart there would
    // deny a save that is real and a DELETE that still works.
    const customerId = await shopper();
    const doomed = await shop();
    const productId = await listing(doomed.storeId, 'Archived later');
    await wishlist.add(customerId, productId);

    await merchants.transition(doomed.merchantId, { event: 'suspend' }, ACTOR);

    expect(await wishlist.list(customerId)).toEqual([]);
    expect(await wishlist.ids(customerId)).toEqual([productId]);
  });

  it('never shows one shopper another shopper’s saves', async () => {
    const mine = await shopper();
    const theirs = await shopper();
    const { storeId } = await shop();
    await wishlist.add(mine, await listing(storeId, 'Mine'));
    await wishlist.add(theirs, await listing(storeId, 'Theirs'));

    expect((await wishlist.list(mine)).map((c) => c.title)).toEqual(['Mine']);
  });

  it('is idempotent on a double tap', async () => {
    const customerId = await shopper();
    const { storeId } = await shop();
    const productId = await listing(storeId, 'Tapped twice');

    await wishlist.add(customerId, productId);
    await wishlist.add(customerId, productId);

    expect(await wishlist.count(customerId)).toBe(1);
  });

  it('shrugs at removing something that was never saved', async () => {
    const customerId = await shopper();
    const { storeId } = await shop();

    await expect(
      wishlist.remove(customerId, await listing(storeId, 'Never saved')),
    ).resolves.toBeUndefined();
  });

  it('refuses to save a product that does not exist', async () => {
    const customerId = await shopper();

    await expect(wishlist.add(customerId, randomUUID())).rejects.toThrow(ProductNotFoundError);
  });

  it('fetches every saved card in one call, not one call per miss', async () => {
    // The regression this exists for. The old path looked saved ids up in the
    // catalogue's top-100 POPULAR page — an unrelated set — and fell back to a
    // full `product()` detail fetch, around seven queries apiece, for every id
    // it missed. Thirty saved items was on the order of two hundred round trips
    // to open one screen.
    //
    // Spying on the two collaborators says exactly that: one batched card read,
    // and the per-id fallback never touched.
    const customerId = await shopper();
    const { storeId } = await shop();
    for (let n = 0; n < 12; n += 1) {
      await wishlist.add(customerId, await listing(storeId, `Saved ${n}`));
    }
    const cardsByIds = vi.spyOn(storefront, 'cardsByIds');
    const perId = vi.spyOn(storefront, 'product');
    const browse = vi.spyOn(storefront, 'browse');

    const rows = await wishlist.list(customerId);

    expect(rows).toHaveLength(12);
    expect(cardsByIds).toHaveBeenCalledTimes(1);
    expect(perId).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
    cardsByIds.mockRestore();
    perId.mockRestore();
    browse.mockRestore();
  });
});
