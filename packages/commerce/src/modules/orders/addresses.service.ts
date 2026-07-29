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
          area: input.area,
          landmark: input.landmark,
          ghanapost_gps: input.ghanapost_gps,
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

  async remove(customerId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(a)
      .where(and(eq(a.id, id), eq(a.customer_id, customerId)))
      .returning({ id: a.id });
    if (!rows[0]) throw new AddressNotFoundError(id);
  }

  /** Unset the customer's current default (optionally excluding one address). */
  private async clearDefault(tx: Executor, customerId: string, exceptId?: string): Promise<void> {
    const where = exceptId
      ? and(eq(a.customer_id, customerId), eq(a.is_default, true), ne(a.id, exceptId))
      : and(eq(a.customer_id, customerId), eq(a.is_default, true));
    await tx.update(a).set({ is_default: false }).where(where);
  }
}
