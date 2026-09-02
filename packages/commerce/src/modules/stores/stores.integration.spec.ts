import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger, SYSTEM_ACTORS, MerchantsService } from '@installment/core';
import { StoresService } from './stores.service';
import { StoreConflictError, StoreNotFoundError, StoreTransitionError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('StoresService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const stores = new StoresService(db, audit);
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
});
