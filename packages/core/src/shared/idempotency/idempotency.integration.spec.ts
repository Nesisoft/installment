import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '@installment/db';
import { DrizzleIdempotencyStore } from './drizzle-store';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyService,
} from './idempotency.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('IdempotencyService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
  const store = new DrizzleIdempotencyStore(db);
  const svc = new IdempotencyService(store);

  afterAll(async () => {
    await pool.end();
  });

  it('caches the response of the first call and replays it', async () => {
    const key = `idem-${randomUUID()}`;
    const handler = vi.fn(async () => ({ body: { receipt: 'r-123' }, status: 201 }));

    const first = await svc.wrap(key, 'h1', handler);
    const second = await svc.wrap(key, 'h1', handler);

    expect(first).toEqual(second);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws Conflict when the same key is reused with a different request hash', async () => {
    const key = `idem-${randomUUID()}`;
    await svc.wrap(key, 'hA', async () => ({ body: 'A', status: 200 }));

    await expect(
      svc.wrap(key, 'hB', async () => ({ body: 'B', status: 200 })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('reports InProgress when a prior reservation has not stored a response yet', async () => {
    const key = `idem-${randomUUID()}`;
    expect(await store.reserve(key, 'h1')).toBe(true);

    await expect(
      svc.wrap(key, 'h1', async () => ({ body: 'x', status: 200 })),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it('releases the reservation when the handler throws so retries can proceed', async () => {
    const key = `idem-${randomUUID()}`;
    const handler = vi
      .fn<() => Promise<{ body: string; status: number }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ body: 'recovered', status: 200 });

    await expect(svc.wrap(key, 'h1', handler)).rejects.toThrow('boom');
    const retried = await svc.wrap(key, 'h1', handler);
    expect(retried).toEqual({ body: 'recovered', status: 200 });
  });

  it('treats an expired key as absent so it can be reused', async () => {
    const key = `idem-${randomUUID()}`;
    // TTL already in the past.
    await svc.wrap(key, 'h1', async () => ({ body: 'old', status: 200 }), { ttlMs: -1_000 });

    expect(await store.find(key)).toBeUndefined();
    // A fresh request under the same key runs rather than replaying stale data.
    const again = await svc.wrap(key, 'h2', async () => ({ body: 'new', status: 200 }));
    expect(again.body).toBe('new');
  });

  it('reclaims a reservation abandoned by a crashed request', async () => {
    const key = `idem-${randomUUID()}`;
    expect(await store.reserve(key, 'h1')).toBe(true);
    // Simulate the process dying before storeResult: backdate the reservation
    // past the takeover timeout. Without reclamation this key would answer
    // "in progress" forever and be unusable until its 24h expiry.
    await db.execute(
      sql`UPDATE idempotency_keys SET created_at = now() - interval '1 hour' WHERE key = ${key}`,
    );

    const recovered = await svc.wrap(key, 'h1', async () => ({ body: 'ok', status: 200 }));
    expect(recovered.body).toBe('ok');
  });

  it('does not reclaim a reservation that is still live', async () => {
    const key = `idem-${randomUUID()}`;
    expect(await store.reserve(key, 'h1')).toBe(true);
    // Fresh reservation — a concurrent request must lose, not steal it.
    expect(await store.reserve(key, 'h1')).toBe(false);
  });

  it('purges expired keys and leaves live ones alone', async () => {
    const expired = `idem-${randomUUID()}`;
    const live = `idem-${randomUUID()}`;
    await svc.wrap(expired, 'h1', async () => ({ body: 1, status: 200 }), { ttlMs: -1_000 });
    await svc.wrap(live, 'h1', async () => ({ body: 2, status: 200 }));

    const purged = await store.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);

    const rows = await db.execute(
      sql`SELECT key FROM idempotency_keys WHERE key IN (${expired}, ${live})`,
    );
    const keys = (rows.rows as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toContain(live);
    expect(keys).not.toContain(expired);
  });
});
