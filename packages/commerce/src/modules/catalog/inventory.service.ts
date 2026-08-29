import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction, type TransactionalTx } from '@installment/core';
import { adjustStockSchema, setStockSchema } from './products.dto';
import { InsufficientStockError, VariantNotFoundError } from './errors';

const inv = schema.inventory;
const pv = schema.product_variants;
const p = schema.products;

export type InventoryRow = typeof schema.inventory.$inferSelect;

/**
 * Per-variant stock. `quantity_available` is sellable now; `quantity_reserved`
 * is held for pending orders. Phase 12 checkout uses reserve → (commit via
 * adjust) / release; Phase 11 only needs setStock/adjust for the seller.
 */
/**
 * Narrows a seller-facing stock operation to one merchant's own variants.
 *
 * Only the three seller entry points below take it. The checkout internals
 * (reserve / release / commit) deliberately do not: they already run against a
 * variant the order has been built from, and a tenant filter there would be a
 * second place for the same rule to drift out of step with the first.
 */
export interface InventoryScope {
  merchantId?: string;
}

export class InventoryService {
  constructor(private readonly db: Database) {}

  async getByVariant(variantId: string, scope: InventoryScope = {}): Promise<InventoryRow> {
    const rows = await this.db
      .select()
      .from(inv)
      .where(and(eq(inv.variant_id, variantId), ...this.ownedBy(scope)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new VariantNotFoundError(variantId);
    return row;
  }

  async setStock(
    variantId: string,
    rawInput: unknown,
    scope: InventoryScope = {},
  ): Promise<InventoryRow> {
    const input = setStockSchema.parse(rawInput);
    const rows = await this.db
      .update(inv)
      .set({
        quantity_available: input.quantity_available,
        ...(input.restock_threshold !== undefined
          ? { restock_threshold: input.restock_threshold }
          : {}),
      })
      .where(and(eq(inv.variant_id, variantId), ...this.ownedBy(scope)))
      .returning();
    const row = rows[0];
    if (!row) throw new VariantNotFoundError(variantId);
    return row;
  }

  /** Signed change to on-hand stock; never drives quantity_available negative. */
  async adjust(
    variantId: string,
    rawInput: unknown,
    scope: InventoryScope = {},
  ): Promise<InventoryRow> {
    const { delta } = adjustStockSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      // Scoped on the lock, so a variant belonging to someone else never even
      // gets read — the caller sees the same "not found" as for a bad uuid.
      const current = await this.lock(tx, variantId, scope);
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

  /**
   * Variant ids belonging to `merchantId`, as a subquery rather than a fetched
   * list: it stays one statement, so there is no window between deciding a
   * variant is the caller's and writing to it.
   */
  private ownedBy(scope: InventoryScope) {
    if (!scope.merchantId) return [];
    return [
      inArray(
        inv.variant_id,
        this.db
          .select({ id: pv.id })
          .from(pv)
          .innerJoin(p, eq(p.id, pv.product_id))
          .where(eq(p.merchant_id, scope.merchantId)),
      ),
    ];
  }

  /**
   * Move `qty` from available → reserved (checkout). Throws if not enough
   * available. Pass `tx` to enlist in a caller's transaction so the reservation
   * commits atomically with the order it backs (checkout does this); omit it and
   * the move runs in its own transaction.
   */
  async reserve(variantId: string, qty: number, tx?: TransactionalTx): Promise<InventoryRow> {
    assertPositiveInt(qty, 'reserve');
    return this.run(tx, (exec) => this.reserveIn(exec, variantId, qty));
  }

  /** Move up to `qty` back from reserved → available (cancel / expiry). */
  async release(variantId: string, qty: number, tx?: TransactionalTx): Promise<InventoryRow> {
    assertPositiveInt(qty, 'release');
    return this.run(tx, (exec) => this.releaseIn(exec, variantId, qty));
  }

  /**
   * Finalise a reservation as sold: drop `qty` from reserved without returning
   * it to available (the goods have left). Used when an order is paid / its
   * financing activates. Clamps to what's reserved so it can never drive the
   * counter negative.
   */
  async commit(variantId: string, qty: number, tx?: TransactionalTx): Promise<InventoryRow> {
    assertPositiveInt(qty, 'commit');
    return this.run(tx, (exec) => this.commitIn(exec, variantId, qty));
  }

  private run<T>(
    tx: TransactionalTx | undefined,
    fn: (exec: TransactionalTx) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : runInTransaction(this.db, fn);
  }

  private async reserveIn(
    tx: TransactionalTx,
    variantId: string,
    qty: number,
  ): Promise<InventoryRow> {
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
  }

  private async releaseIn(
    tx: TransactionalTx,
    variantId: string,
    qty: number,
  ): Promise<InventoryRow> {
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
  }

  private async commitIn(
    tx: TransactionalTx,
    variantId: string,
    qty: number,
  ): Promise<InventoryRow> {
    const current = await this.lock(tx, variantId);
    const committed = Math.min(qty, current.quantity_reserved);
    const rows = await tx
      .update(inv)
      .set({ quantity_reserved: current.quantity_reserved - committed })
      .where(eq(inv.variant_id, variantId))
      .returning();
    return rows[0]!;
  }

  private async lock(
    tx: Pick<Database, 'select'>,
    variantId: string,
    scope: InventoryScope = {},
  ): Promise<InventoryRow> {
    const rows = await tx
      .select()
      .from(inv)
      .where(and(eq(inv.variant_id, variantId), ...this.ownedBy(scope)))
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
