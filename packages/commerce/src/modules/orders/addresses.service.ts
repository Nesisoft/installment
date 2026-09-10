import { and, desc, eq, ne } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction } from '@installment/core';
import {
  createAddressSchema,
  updateAddressSchema,
  type CreateAddressInput,
  type UpdateAddressInput,
} from './dto';
import { AddressNotFoundError } from './errors';

const a = schema.addresses;

export type Address = typeof schema.addresses.$inferSelect;

type Executor = Pick<Database, 'update'>;

/**
 * A customer's shipping addresses. Customer-owned and high-frequency, so these
 * are not audited (unlike the engine's lifecycle entities). At most one default
 * per customer is enforced by a partial unique index; setting a new default
 * clears the previous one in the same transaction.
 */
export class AddressesService {
  constructor(private readonly db: Database) {}

  async create(customerId: string, rawInput: unknown): Promise<Address> {
    const input: CreateAddressInput = createAddressSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      if (input.is_default) await this.clearDefault(tx, customerId);
      const rows = await tx
        .insert(a)
        .values({
          customer_id: customerId,
          recipient: input.recipient,
          phone: input.phone,
          region: input.region,
          city: input.city,
          // `?? null` rather than passing through: the DTO accepts absent OR
          // null for these, and the column should not care which client asked.
          area: input.area ?? null,
          landmark: input.landmark ?? null,
          ghanapost_gps: input.ghanapost_gps ?? null,
          is_default: input.is_default ?? false,
        })
        .returning();
      return rows[0]!;
    });
  }

  async list(customerId: string): Promise<Address[]> {
    return this.db
      .select()
      .from(a)
      .where(eq(a.customer_id, customerId))
      .orderBy(desc(a.is_default), desc(a.created_at));
  }

  async get(customerId: string, id: string): Promise<Address> {
    const rows = await this.db
      .select()
      .from(a)
      .where(and(eq(a.id, id), eq(a.customer_id, customerId)))
      .limit(1);
    if (!rows[0]) throw new AddressNotFoundError(id);
    return rows[0];
  }

  async update(customerId: string, id: string, rawPatch: unknown): Promise<Address> {
    const patch: UpdateAddressInput = updateAddressSchema.parse(rawPatch);
    return runInTransaction(this.db, async (tx) => {
      if (patch.is_default) await this.clearDefault(tx, customerId, id);
      const rows = await tx
        .update(a)
        .set({ ...patch })
        .where(and(eq(a.id, id), eq(a.customer_id, customerId)))
        .returning();
      if (!rows[0]) throw new AddressNotFoundError(id);
      return rows[0];
    });
  }

  async setDefault(customerId: string, id: string): Promise<Address> {
    return runInTransaction(this.db, async (tx) => {
      await this.clearDefault(tx, customerId, id);
      const rows = await tx
        .update(a)
        .set({ is_default: true })
        .where(and(eq(a.id, id), eq(a.customer_id, customerId)))
        .returning();
      if (!rows[0]) throw new AddressNotFoundError(id);
      return rows[0];
    });
  }

  /**
   * Delete an address, and never leave the customer without a default.
   *
   * The promotion is the point. `addresses_one_default_idx` enforces *at most*
   * one default and nothing enforced *at least* one, so deleting the default
   * left a customer with several addresses and none of them marked — and
   * checkout's `shipping_address_id` is optional, so the next order did not
   * fail loudly, it quietly fell through to the national delivery price.
   *
   * The successor is the newest surviving address, which is the same order
   * `list` puts them in, so the one that moves to the top of the screen is the
   * one that became the default.
   *
   * In a transaction because the two writes are one decision: a delete that
   * committed without its promotion would leave exactly the state this exists
   * to prevent.
   */
  async remove(customerId: string, id: string): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .delete(a)
        .where(and(eq(a.id, id), eq(a.customer_id, customerId)))
        .returning({ id: a.id, was_default: a.is_default });
      const deleted = rows[0];
      if (!deleted) throw new AddressNotFoundError(id);
      if (!deleted.was_default) return;

      const successor = await tx
        .select({ id: a.id })
        .from(a)
        .where(eq(a.customer_id, customerId))
        .orderBy(desc(a.created_at))
        .limit(1);
      // None left is a fine outcome — the customer has no addresses at all.
      if (successor[0]) {
        await tx.update(a).set({ is_default: true }).where(eq(a.id, successor[0].id));
      }
    });
  }

  /** Unset the customer's current default (optionally excluding one address). */
  private async clearDefault(tx: Executor, customerId: string, exceptId?: string): Promise<void> {
    const where = exceptId
      ? and(eq(a.customer_id, customerId), eq(a.is_default, true), ne(a.id, exceptId))
      : and(eq(a.customer_id, customerId), eq(a.is_default, true));
    await tx.update(a).set({ is_default: false }).where(where);
  }
}
