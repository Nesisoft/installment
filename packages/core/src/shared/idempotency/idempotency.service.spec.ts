import { describe, expect, it, vi } from 'vitest';
import {
  IdempotencyConflictError,
  IdempotencyError,
  IdempotencyInProgressError,
  IdempotencyService,
  type IdempotencyStore,
  type StoredIdempotencyRow,
} from './idempotency.service';

/** In-memory store that faithfully models the reserve / store / release semantics. */
class FakeStore implements IdempotencyStore {
  rows = new Map<string, StoredIdempotencyRow>();

  reserve(key: string, requestHash: string): Promise<boolean> {
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, {
      key,
      request_hash: requestHash,
      response_body: null,
      response_status: null,
    });
    return Promise.resolve(true);
  }
  find(key: string) {
    return Promise.resolve(this.rows.get(key));
  }
  storeResult(key: string, body: unknown, status: number): Promise<void> {
    const row = this.rows.get(key);
    if (row) {
      row.response_body = body;
      row.response_status = status;
    }
    return Promise.resolve();
  }
  releaseReservation(key: string, requestHash: string): Promise<void> {
    const row = this.rows.get(key);
    if (row && row.request_hash === requestHash && row.response_body === null) {
      this.rows.delete(key);
    }
    return Promise.resolve();
  }
}

describe('IdempotencyService.wrap', () => {
  it('runs the handler once and caches the response', async () => {
    const store = new FakeStore();
    const svc = new IdempotencyService(store);
    const handler = vi.fn(async () => ({ body: { ok: true }, status: 201 }));

    const first = await svc.wrap('k1', 'h1', handler);
    const second = await svc.wrap('k1', 'h1', handler);

    expect(first).toEqual({ body: { ok: true }, status: 201 });
    expect(second).toEqual({ body: { ok: true }, status: 201 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws IdempotencyConflictError on the same key with a different request hash', async () => {
    const store = new FakeStore();
    const svc = new IdempotencyService(store);
    await svc.wrap('k1', 'hashA', async () => ({ body: 1, status: 200 }));

    await expect(
      svc.wrap('k1', 'hashB', async () => ({ body: 2, status: 200 })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('throws IdempotencyInProgressError when an earlier call has reserved but not finished', async () => {
    const store = new FakeStore();
    const svc = new IdempotencyService(store);
    // Simulate a reservation by an earlier in-flight request.
    await store.reserve('k1', 'h1');

    await expect(
      svc.wrap('k1', 'h1', async () => ({ body: 'x', status: 200 })),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it('releases the reservation when the handler throws so retries are possible', async () => {
    const store = new FakeStore();
    const svc = new IdempotencyService(store);
    const handler = vi
      .fn<() => Promise<{ body: string; status: number }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ body: 'recovered', status: 200 });

    await expect(svc.wrap('k1', 'h1', handler)).rejects.toThrow('boom');
    expect(store.rows.has('k1')).toBe(false);

    const retried = await svc.wrap('k1', 'h1', handler);
    expect(retried).toEqual({ body: 'recovered', status: 200 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects empty key or hash', async () => {
    const svc = new IdempotencyService(new FakeStore());
    await expect(svc.wrap('', 'h', async () => ({ body: 1, status: 200 }))).rejects.toBeInstanceOf(
      IdempotencyError,
    );
    await expect(svc.wrap('k', '', async () => ({ body: 1, status: 200 }))).rejects.toBeInstanceOf(
      IdempotencyError,
    );
  });
});
