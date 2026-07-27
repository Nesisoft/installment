import { eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction } from '@installment/core';
import { adjustStockSchema, setStockSchema } from './products.dto';
import { InsufficientStockError, VariantNotFoundError } from './errors';

const inv = schema.inventory;

export type InventoryRow = typeof schema.inventory.$inferSelect;

/**
 * Per-variant stock. `quantity_available` is sellable now; `quantity_reserved`
 * is held for pending orders. Phase 12 checkout uses reserve → (commit via
 * adjust) / release; Phase 11 only needs setStock/adjust for the seller.
 */
export class InventoryService {
  constructor(private readonly db: Database) {}

  async getByVariant(variantId: string): Promise<InventoryRow> {
    const rows = await this.db.select().from(inv).where(eq(inv.variant_id, variantId)).limit(1);
    const row = rows[0];
    if (!row) throw new VariantNotFoundError(variantId);
    return row;
  }

  async setStock(variantId: string, rawInput: unknown): Promise<InventoryRow> {
    const input = setStockSchema.parse(rawInput);
    const rows = await this.db
      .update(inv)
      .set({
        quantity_available: input.quantity_available,
        ...(input.restock_threshold !== undefined
          ? { restock_threshold: input.restock_threshold }
          : {}),
      })
      .where(eq(inv.variant_id, variantId))
      .returning();
    const row = rows[0];
    if (!row) throw new VariantNotFoundError(variantId);
    return row;
  }

  /** Signed change to on-hand stock; never drives quantity_available negative. */
  async adjust(variantId: string, rawInput: unknown): Promise<InventoryRow> {
    const { delta } = adjustStockSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const current = await this.lock(tx, variantId);
      const next = current.quantity_available + delta;
      if (next < 0) {
        throw new InsufficientStockError(variantId, -delta, current.quantity_available);
      }
      const rows = await tx
        .update(inv)
        .set({ quantity_available: next })
        .where(eq(inv.variant_id, variantId))
        .returning();
      return rows[0]!;
    });
  }

  /** Move `qty` from available → reserved (checkout). Throws if not enough available. */
  async reserve(variantId: string, qty: number): Promise<InventoryRow> {
    assertPositiveInt(qty, 'reserve');
    return runInTransaction(this.db, async (tx) => {
      const current = await this.lock(tx, variantId);
      if (current.quantity_available < qty) {
        throw new InsufficientStockError(variantId, qty, current.quantity_available);
      }
      const rows = await tx
        .update(inv)
        .set({
          quantity_available: current.quantity_available - qty,
          quantity_reserved: current.quantity_reserved + qty,
        })
        .where(eq(inv.variant_id, variantId))
        .returning();
      return rows[0]!;
    });
  }

  /** Move up to `qty` back from reserved → available (cancel / expiry). */
  async release(variantId: string, qty: number): Promise<InventoryRow> {
    assertPositiveInt(qty, 'release');
    return runInTransaction(this.db, async (tx) => {
      const current = await this.lock(tx, variantId);
      const released = Math.min(qty, current.quantity_reserved);
      const rows = await tx
        .update(inv)
        .set({
          quantity_available: current.quantity_available + released,
          quantity_reserved: current.quantity_reserved - released,
        })
        .where(eq(inv.variant_id, variantId))
        .returning();
      return rows[0]!;
    });
  }

  private async lock(tx: Pick<Database, 'select'>, variantId: string): Promise<InventoryRow> {
    const rows = await tx
      .select()
      .from(inv)
      .where(eq(inv.variant_id, variantId))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) throw new VariantNotFoundError(variantId);
    return row;
  }
}

function assertPositiveInt(qty: number, op: string): void {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`${op} quantity must be a positive integer`);
  }
}
