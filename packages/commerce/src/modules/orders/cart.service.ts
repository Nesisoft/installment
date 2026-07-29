import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { isUniqueViolation } from '@installment/core';
import { addCartItemSchema, setCartItemQuantitySchema } from './dto';
import { CartItemNotFoundError, NotPurchasableError } from './errors';

const c = schema.carts;
const ci = schema.cart_items;
const pv = schema.product_variants;
const p = schema.products;

export type Cart = typeof schema.carts.$inferSelect;
export type CartItem = typeof schema.cart_items.$inferSelect;

export interface CartWithItems extends Cart {
  items: CartItem[];
  subtotal_pesewas: number;
}

interface PurchasableVariant {
  variantId: string;
  merchantId: string;
  unitPricePesewas: number;
}

/**
 * The customer's active shopping cart. One active cart per customer (partial
 * unique index). Prices are snapshotted onto the line at add-time; the cart may
 * span multiple merchants and is split into one order per merchant at checkout
 * (Phase 12 next slice). Not audited — customer-owned and high-frequency.
 */
export class CartService {
  constructor(private readonly db: Database) {}

  async getOrCreateActiveCart(customerId: string): Promise<Cart> {
    const existing = await this.activeCart(customerId);
    if (existing) return existing;
    try {
      const rows = await this.db.insert(c).values({ customer_id: customerId }).returning();
      return rows[0]!;
    } catch (err) {
      // Lost a race on the one-active-cart index — re-read the winner.
      if (isUniqueViolation(err)) {
        const cart = await this.activeCart(customerId);
        if (cart) return cart;
      }
      throw err;
    }
  }

  async getCart(customerId: string): Promise<CartWithItems> {
    const cart = await this.getOrCreateActiveCart(customerId);
    const items = await this.db
      .select()
      .from(ci)
      .where(eq(ci.cart_id, cart.id))
      .orderBy(ci.created_at);
    const subtotal = items.reduce((sum, it) => sum + it.unit_price_pesewas * it.quantity, 0);
    return { ...cart, items, subtotal_pesewas: subtotal };
  }

  async addItem(customerId: string, rawInput: unknown): Promise<CartWithItems> {
    const input = addCartItemSchema.parse(rawInput);
    const cart = await this.getOrCreateActiveCart(customerId);
    const variant = await this.resolvePurchasable(input.variant_id);

    // Upsert: a repeat add increments the quantity on the existing line.
    await this.db
      .insert(ci)
      .values({
        cart_id: cart.id,
        variant_id: variant.variantId,
        merchant_id: variant.merchantId,
        quantity: input.quantity,
        unit_price_pesewas: variant.unitPricePesewas,
      })
      .onConflictDoUpdate({
        target: [ci.cart_id, ci.variant_id],
        set: { quantity: sql`${ci.quantity} + ${input.quantity}` },
      });

    return this.getCart(customerId);
  }

  async setItemQuantity(
    customerId: string,
    variantId: string,
    rawInput: unknown,
  ): Promise<CartWithItems> {
    const { quantity } = setCartItemQuantitySchema.parse(rawInput);
    const cart = await this.getOrCreateActiveCart(customerId);
    if (quantity === 0) {
      await this.db.delete(ci).where(and(eq(ci.cart_id, cart.id), eq(ci.variant_id, variantId)));
    } else {
      const rows = await this.db
        .update(ci)
        .set({ quantity })
        .where(and(eq(ci.cart_id, cart.id), eq(ci.variant_id, variantId)))
        .returning({ id: ci.id });
      if (!rows[0]) throw new CartItemNotFoundError(variantId);
    }
    return this.getCart(customerId);
  }

  async removeItem(customerId: string, variantId: string): Promise<CartWithItems> {
    const cart = await this.getOrCreateActiveCart(customerId);
    await this.db.delete(ci).where(and(eq(ci.cart_id, cart.id), eq(ci.variant_id, variantId)));
    return this.getCart(customerId);
  }

  async clear(customerId: string): Promise<CartWithItems> {
    const cart = await this.getOrCreateActiveCart(customerId);
    await this.db.delete(ci).where(eq(ci.cart_id, cart.id));
    return this.getCart(customerId);
  }

  // ------------------------------------------------------------- internal

  private async activeCart(customerId: string): Promise<Cart | undefined> {
    const rows = await this.db
      .select()
      .from(c)
      .where(and(eq(c.customer_id, customerId), eq(c.status, 'active')))
      .limit(1);
    return rows[0];
  }

  /** Resolves a variant's merchant + effective unit price, enforcing that the
   * product + variant are actually purchasable (active, not archived/deleted). */
  private async resolvePurchasable(variantId: string): Promise<PurchasableVariant> {
    const rows = await this.db
      .select({
        variantId: pv.id,
        variantActive: pv.is_active,
        variantPrice: pv.price_pesewas,
        productStatus: p.status,
        productDeleted: p.deleted_at,
        basePrice: p.base_price_pesewas,
        merchantId: p.merchant_id,
      })
      .from(pv)
      .innerJoin(p, eq(p.id, pv.product_id))
      .where(eq(pv.id, variantId))
      .limit(1);
    const r = rows[0];
    if (!r) throw new NotPurchasableError(`Variant "${variantId}" not found`);
    if (!r.variantActive) throw new NotPurchasableError(`Variant "${variantId}" is not active`);
    if (r.productStatus !== 'active' || r.productDeleted) {
      throw new NotPurchasableError(`Product for variant "${variantId}" is not purchasable`);
    }
    return {
      variantId: r.variantId,
      merchantId: r.merchantId,
      unitPricePesewas: r.variantPrice ?? r.basePrice,
    };
  }
}
