import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
});
