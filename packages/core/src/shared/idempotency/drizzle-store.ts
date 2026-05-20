import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { IdempotencyStore, StoredIdempotencyRow } from './idempotency.service';

const t = schema.idempotency_keys;

/** Production {@link IdempotencyStore} backed by Drizzle + Postgres. */
export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Pick<Database, 'insert' | 'select' | 'update' | 'delete'>) {}

  async reserve(key: string, requestHash: string, expiresAt?: Date): Promise<boolean> {
    const rows = await this.db
      .insert(t)
      .values({
        key,
        request_hash: requestHash,
        ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
      })
      .onConflictDoNothing()
      .returning({ key: t.key });
    return rows.length === 1;
  }

  async find(key: string): Promise<StoredIdempotencyRow | undefined> {
    const rows = await this.db
      .select({
        key: t.key,
        request_hash: t.request_hash,
        response_body: t.response_body,
        response_status: t.response_status,
      })
      .from(t)
      .where(eq(t.key, key))
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
}
