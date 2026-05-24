export interface CachedResponse<T = unknown> {
  body: T;
  status: number;
}

export interface StoredIdempotencyRow {
  key: string;
  request_hash: string;
  response_body: unknown | null;
  response_status: number | null;
}

/**
 * The narrow port {@link IdempotencyService} actually uses. Swappable so the
 * service is unit-testable without a Drizzle harness.
 */
export interface IdempotencyStore {
  /** Atomic reserve: returns true if WE inserted, false if a row already existed. */
  reserve(key: string, requestHash: string, expiresAt?: Date): Promise<boolean>;
  find(key: string): Promise<StoredIdempotencyRow | undefined>;
  storeResult(key: string, body: unknown, status: number): Promise<void>;
  releaseReservation(key: string, requestHash: string): Promise<void>;
}

export interface WrapOptions {
  /** Override the row's expires_at (default is the DB-level 24h). */
  ttlMs?: number;
}

export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

/** Same key, different request payload — almost always a client bug or replay. */
export class IdempotencyConflictError extends IdempotencyError {
  constructor(key: string) {
    super(`Idempotency key "${key}" was used with a different request hash`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Same key, same hash, but an earlier request hasn't finished yet. */
export class IdempotencyInProgressError extends IdempotencyError {
  constructor(key: string) {
    super(`Earlier request with idempotency key "${key}" is still in progress`);
    this.name = 'IdempotencyInProgressError';
  }
}

/**
 * Idempotency middleware on the `idempotency_keys` table.
 *
 * `wrap(key, requestHash, handler)`:
 *   - first call:  reserves the key, runs handler, caches its response;
 *   - replay:      same key + same hash → returns the cached response;
 *   - conflict:    same key + different hash → IdempotencyConflictError;
 *   - in-flight:   reservation exists but no response yet → IdempotencyInProgressError.
 * If the handler throws, the reservation is released so retries with the same
 * key+hash can run.
 */
export class IdempotencyService {
  constructor(private readonly store: IdempotencyStore) {}

  async wrap<T = unknown>(
    key: string,
    requestHash: string,
    handler: () => Promise<CachedResponse<T>>,
    opts?: WrapOptions,
  ): Promise<CachedResponse<T>> {
    if (!key) throw new IdempotencyError('idempotency key is required');
    if (!requestHash) throw new IdempotencyError('requestHash is required');

    const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs) : undefined;
    const reserved = await this.store.reserve(key, requestHash, expiresAt);

    if (reserved) {
      try {
        const result = await handler();
        await this.store.storeResult(key, result.body, result.status);
        return result;
      } catch (err) {
        await this.store.releaseReservation(key, requestHash).catch(() => undefined);
        throw err;
      }
    }

    const existing = await this.store.find(key);
    if (!existing) {
      // The reservation row disappeared between reserve() returning false and
      // find() — extremely rare race; treat as a retryable error.
      throw new IdempotencyInProgressError(key);
    }
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyConflictError(key);
    }
    if (existing.response_status === null) {
      throw new IdempotencyInProgressError(key);
    }
    return {
      body: existing.response_body as T,
      status: existing.response_status,
    };
  }
}
