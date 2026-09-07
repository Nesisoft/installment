import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import {
  AuditLogger,
  MerchantsService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { MediaService } from '../catalog/media';
import { StorefrontService } from '../catalog/storefront.service';
import { StoresService } from './stores.service';
import { StoreConflictError, StoreNotFoundError, StoreTransitionError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('StoresService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const stores = new StoresService(db, audit);
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const merchants = new MerchantsService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const slug = () => `shop-${randomUUID().slice(0, 8)}`;

  async function freshMerchant(): Promise<string> {
    const id = randomUUID();
    const m = await merchants.create(
      {
        business_name: `Store Co ${id}`,
        legal_name: `Store Co Ltd ${id}`,
        email: `store+${id}@example.gh`,
        phone: '+233244000000',
      },
      SYSTEM_ACTOR,
    );
    return m.id;
  }

  it('creates a store in draft, activates it, and finds it by public slug', async () => {
    const s = slug();
    const store = await stores.create(
      { merchant_id: await freshMerchant(), slug: s, display_name: 'Test Shop' },
      SYSTEM_ACTOR,
    );
    expect(store.status).toBe('draft');

    // draft is not publicly visible
    await expect(stores.getActiveBySlug(s)).rejects.toBeInstanceOf(StoreNotFoundError);

    const active = await stores.transition(store.id, { event: 'activate' }, SYSTEM_ACTOR);
    expect(active.status).toBe('active');
    expect((await stores.getActiveBySlug(s)).id).toBe(store.id);
  });

  it('enforces one store per merchant', async () => {
    const merchantId = await freshMerchant();
    await stores.create(
      { merchant_id: merchantId, slug: slug(), display_name: 'First' },
      SYSTEM_ACTOR,
    );
    await expect(
      stores.create(
        { merchant_id: merchantId, slug: slug(), display_name: 'Second' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('rejects a slug already taken by another store', async () => {
    const shared = slug();
    await stores.create(
      { merchant_id: await freshMerchant(), slug: shared, display_name: 'A' },
      SYSTEM_ACTOR,
    );
    await expect(
      stores.create(
        { merchant_id: await freshMerchant(), slug: shared, display_name: 'B' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('rejects an illegal transition (unsuspend from draft)', async () => {
    const store = await stores.create(
      { merchant_id: await freshMerchant(), slug: slug(), display_name: 'X' },
      SYSTEM_ACTOR,
    );
    await expect(
      stores.transition(store.id, { event: 'unsuspend' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(StoreTransitionError);
  });

  /**
   * The filter the admin review screen needs. `getByMerchant` could already
   * answer it and the HTTP surface could not, so the only way to open a
   * signed-up merchant's shop was a hand-rolled request.
   */
  it('lists only the named merchant’s shopfront', async () => {
    const mine = await freshMerchant();
    const theirs = await freshMerchant();
    const created = await stores.create(
      { merchant_id: mine, slug: slug(), display_name: 'Mine' },
      SYSTEM_ACTOR,
    );
    await stores.create(
      { merchant_id: theirs, slug: slug(), display_name: 'Theirs' },
      SYSTEM_ACTOR,
    );

    const rows = await stores.list({ merchant_id: mine });

    expect(rows.map((r) => r.id)).toEqual([created.id]);
  });

  it('combines the merchant filter with the status filter', async () => {
    const merchantId = await freshMerchant();
    const store = await stores.create(
      { merchant_id: merchantId, slug: slug(), display_name: 'Draft shop' },
      SYSTEM_ACTOR,
    );

    expect(await stores.list({ merchant_id: merchantId, status: 'draft' })).toHaveLength(1);
    expect(await stores.list({ merchant_id: merchantId, status: 'active' })).toHaveLength(0);

    await stores.transition(store.id, { event: 'activate' }, SYSTEM_ACTOR);
    expect(await stores.list({ merchant_id: merchantId, status: 'active' })).toHaveLength(1);
  });

  it('updates a store and throws for an unknown id', async () => {
    const store = await stores.create(
      { merchant_id: await freshMerchant(), slug: slug(), display_name: 'Old' },
      SYSTEM_ACTOR,
    );
    const updated = await stores.update(store.id, { display_name: 'New Name' }, SYSTEM_ACTOR);
    expect(updated.display_name).toBe('New Name');
    await expect(stores.get(randomUUID())).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  /**
   * Where the shop trades.
   *
   * `stores.city` and `stores.region` have been columns since the storefront
   * shipped, and `StorefrontService.store()` has been reading them the whole
   * time — but no schema accepted either, so every shop on the marketplace
   * showed no location and the seller had no way to give one. These go through
   * the real update path and out the public reader, because the bug was
   * precisely that the two ends were never joined.
   */
  describe('city and region', () => {
    /** A store a shopper can actually reach: both the shop and its merchant live. */
    async function publicStore(): Promise<{ id: string; slug: string }> {
      const merchantId = await freshMerchant();
      const s = slug();
      const store = await stores.create(
        { merchant_id: merchantId, slug: s, display_name: 'Adepa Couture' },
        SYSTEM_ACTOR,
      );
      await stores.transition(store.id, { event: 'activate' }, SYSTEM_ACTOR);
      // `StorefrontService.store()` only answers for a live merchant, and a
      // merchant's first activation needs approved KYC behind it. Neither is
      // this spec's subject; both are what a shopper reaching the shop implies.
      await approveRequiredMerchantKyc(db, merchantId, SYSTEM_ACTOR);
      await merchants.transition(merchantId, { event: 'activate' }, SYSTEM_ACTOR);
      return { id: store.id, slug: s };
    }

    it('carries a merchant-set market through to the storefront', async () => {
      const store = await publicStore();

      const patched = await stores.update(
        store.id,
        { city: 'Accra', region: 'Greater Accra' },
        SYSTEM_ACTOR,
        // Scoped exactly as the merchant route calls it, so this proves the
        // seller's own door, not the admin one.
        { merchantId: (await stores.get(store.id)).merchant_id },
      );
      expect(patched.city).toBe('Accra');
      expect(patched.region).toBe('Greater Accra');

      const shopper = await storefront.store(store.slug);
      expect(shopper.city).toBe('Accra');
      expect(shopper.region).toBe('Greater Accra');
    });

    it('lets a seller clear it again', async () => {
      const store = await publicStore();
      await stores.update(store.id, { city: 'Kumasi', region: 'Ashanti' }, SYSTEM_ACTOR);

      const cleared = await stores.update(store.id, { city: null, region: null }, SYSTEM_ACTOR);

      expect(cleared.city).toBeNull();
      expect(cleared.region).toBeNull();
      expect((await storefront.store(store.slug)).region).toBeNull();
    });

    it('leaves the market alone when the patch does not mention it', async () => {
      // The distinction a partial schema has to keep: absent is not null. A
      // seller editing their tagline must not silently lose their location.
      const store = await publicStore();
      await stores.update(store.id, { city: 'Takoradi', region: 'Western' }, SYSTEM_ACTOR);

      const renamed = await stores.update(store.id, { display_name: 'Adepa' }, SYSTEM_ACTOR);

      expect(renamed.city).toBe('Takoradi');
      expect(renamed.region).toBe('Western');
    });

    it('refuses a region outside the sixteen', async () => {
      const store = await publicStore();
      // "Brong Ahafo" is the pre-2019 vocabulary — the one a seller of ten
      // years' standing would type, and the one no delivery zone mentions.
      await expect(
        stores.update(store.id, { region: 'Brong Ahafo' }, SYSTEM_ACTOR),
      ).rejects.toThrow();
      expect((await stores.get(store.id)).region).toBeNull();
    });

    it('accepts a market at creation, which is where signup would set one', async () => {
      const created = await stores.create(
        {
          merchant_id: await freshMerchant(),
          slug: slug(),
          display_name: 'Kejetia Fabrics',
          city: 'Kumasi',
          region: 'Ashanti',
        },
        SYSTEM_ACTOR,
      );
      expect(created.city).toBe('Kumasi');
      expect(created.region).toBe('Ashanti');
    });
  });
});
