import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { IdempotencyStore, StoredIdempotencyRow } from './idempotency.service';

const t = schema.idempotency_keys;

/**
 * How long a reservation may sit without a recorded response before another
 * request may take it over. Covers the crash window: a process that dies
 * between `reserve()` and `storeResult()` leaves a row with a null response,
 * and without reclamation every retry of that key would fail as
 * "in progress" forever — bricking the key until its 24h expiry.
 */
const RESERVATION_TIMEOUT_MS = 5 * 60_000;

/** Production {@link IdempotencyStore} backed by Drizzle + Postgres. */
export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Pick<Database, 'insert' | 'select' | 'update' | 'delete'>) {}

  /**
   * Atomic reserve. Wins if the key is new, or if the existing row is expired
   * or is an abandoned reservation — otherwise loses to the live holder.
   *
   * The takeover is expressed as a conditional upsert rather than a
   * read-then-write so it stays atomic: two concurrent requests reclaiming the
   * same stale row cannot both win.
   */
  async reserve(key: string, requestHash: string, expiresAt?: Date): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const staleBefore = new Date(Date.now() - RESERVATION_TIMEOUT_MS).toISOString();

    const rows = await this.db
      .insert(t)
      .values({
        key,
        request_hash: requestHash,
        ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
      })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          request_hash: requestHash,
          response_body: null,
          response_status: null,
          created_at: nowIso,
          ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
        },
        // Only reclaim a row that is expired, or one whose reservation was
        // abandoned. A live holder (response recorded, or recently reserved)
        // is left untouched and this returns no row.
        setWhere: or(
          lt(t.expires_at, sql`now()`),
          and(isNull(t.response_status), lt(t.created_at, staleBefore)),
        ),
      })
      .returning({ key: t.key });
    return rows.length === 1;
  }

  /** Returns the row only while it is still live — an expired row reads as absent. */
  async find(key: string): Promise<StoredIdempotencyRow | undefined> {
    const rows = await this.db
      .select({
        key: t.key,
        request_hash: t.request_hash,
        response_body: t.response_body,
        response_status: t.response_status,
      })
      .from(t)
      .where(and(eq(t.key, key), gt(t.expires_at, sql`now()`)))
      .limit(1);
    return rows[0];
  }

  async storeResult(key: string, body: unknown, status: number): Promise<void> {
    await this.db
      .update(t)
      .set({ response_body: body, response_status: status })
      .where(eq(t.key, key));
  }

  async releaseReservation(key: string, requestHash: string): Promise<void> {
    await this.db
      .delete(t)
      .where(and(eq(t.key, key), eq(t.request_hash, requestHash), isNull(t.response_body)));
  }

  /**
   * Deletes expired keys. Nothing purged them before, so the table grew
   * without bound once anything started writing to it.
   * Uses `idempotency_keys_expiry_idx`. Returns the number removed.
   */
  async purgeExpired(limit = 5_000): Promise<number> {
    const rows = await this.db
      .delete(t)
      .where(
        sql`${t.key} IN (SELECT key FROM idempotency_keys WHERE expires_at <= now() LIMIT ${limit})`,
      )
      .returning({ key: t.key });
    return rows.length;
  }
}
