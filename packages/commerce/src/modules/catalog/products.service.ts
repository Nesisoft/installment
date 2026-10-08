import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  AuditLogger,
  type AuditActorType,
  runInTransaction,
  isUniqueViolation,
} from '@installment/core';
import {
  addImageSchema,
  addVariantSchema,
  createProductSchema,
  dealRuleIssue,
  listProductsSchema,
  searchProductsSchema,
  setPlanOffersSchema,
  updateProductSchema,
  type AddImageInput,
  type AddVariantInput,
  type CreateProductInput,
  type ListProductsInput,
  type SearchProductsInput,
  type SetPlanOffersInput,
  type UpdateProductInput,
  type VariantInput,
} from './products.dto';
import { ProductConflictError, ProductNotFoundError, ProductValidationError } from './errors';
import type { InventoryRow } from './inventory.service';

const p = schema.products;
const pv = schema.product_variants;
const pi = schema.product_images;
const inv = schema.inventory;
const ppo = schema.product_plan_offers;
const st = schema.stores;
const pt = schema.plan_templates;

/** Product columns minus the internal `search_tsv` (never returned to callers). */
/**
 * A merchant's catalogue in five numbers — what the home screen's "needs your
 * action" rows and the catalogue tab's filter chips are counting.
 */
/** One buyable variant of a product, with what is on the shelf. */
export interface ProductVariantStock {
  id: string;
  sku: string;
  /** `{"size":"L"}` — whatever the seller named their options. */
  option_values: Record<string, unknown>;
  /** `null` means the variant sells at the product's base price. */
  price_pesewas: number | null;
  quantity_available: number;
  restock_threshold: number;
}

export interface MerchantCatalogSummary {
  products: number;
  liveProducts: number;
  variants: number;
  /** Active variants of undeleted products with nothing on the shelf. */
  outOfStockVariants: number;
  /** At or below the variant's own restock threshold, but not yet at zero. */
  lowStockVariants: number;
}

/**
 * The columns every product read returns.
 *
 * Exported so `api-types-mirror.spec.ts` can compare its keys against
 * `PRODUCT_FIELDS` — the published `Product` interface had fallen four fields
 * behind this object, and a type mirror is the one drift that spec could not
 * otherwise catch.
 */
export const productCols = {
  id: p.id,
  store_id: p.store_id,
  merchant_id: p.merchant_id,
  category_id: p.category_id,
  title: p.title,
  description: p.description,
  status: p.status,
  base_price_pesewas: p.base_price_pesewas,
  currency: p.currency,
  attributes: p.attributes,
  metadata: p.metadata,
  compare_at_price_pesewas: p.compare_at_price_pesewas,
  deal_ends_at: p.deal_ends_at,
  created_at: p.created_at,
  updated_at: p.updated_at,
  deleted_at: p.deleted_at,
};

export type Product = Omit<typeof schema.products.$inferSelect, 'search_tsv'>;
export type ProductVariant = typeof schema.product_variants.$inferSelect;
export type ProductImage = typeof schema.product_images.$inferSelect;

export interface ProductDetails extends Product {
  variants: (ProductVariant & { inventory: InventoryRow | null })[];
  images: ProductImage[];
  plan_template_ids: string[];
}

export interface ProductActor {
  actorId: string;
  actorType: AuditActorType;
}

/**
 * Narrows an operation to one merchant's own catalogue.
 *
 * Optional because the admin surface is deliberately unscoped — back-office
 * staff edit any store's products. When it is set the merchant id goes into the
 * WHERE clause rather than into a check afterwards, so another merchant's
 * product is indistinguishable from one that does not exist: a 404, never a
 * 403. A 403 would confirm the product is real, which is a slow catalogue leak
 * for anyone willing to enumerate uuids.
 */
export interface ProductScope {
  merchantId?: string;
}

/**
 * Products and their nested variants / images / installment plan offers, plus
 * the inventory row bootstrapped per variant. `create` accepts the whole
 * "upload a product" payload in one transaction (roadmap Phase 11 DoD).
 */
export class ProductsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(
    rawInput: unknown,
    actor: ProductActor,
    scope: ProductScope = {},
  ): Promise<ProductDetails> {
    const input: CreateProductInput = createProductSchema.parse(rawInput);
    // Both halves are in the body here, so this is a plain check. `update` has
    // to merge with the stored row first — see there.
    const dealIssue = dealRuleIssue(input);
    if (dealIssue) throw new ProductValidationError(dealIssue);
    // Both halves are in the body here, so this is a plain check. `update` has
    // to merge with the stored row first — see there.

    const id = await runInTransaction(this.db, async (tx) => {
      const storeRows = await tx
        .select({ id: st.id, merchant_id: st.merchant_id })
        .from(st)
        .where(
          and(
            eq(st.id, input.store_id),
            isNull(st.deleted_at),
            // Scoping the store lookup is what stops a merchant listing a
            // product into somebody else's shop by passing their store_id.
            ...(scope.merchantId ? [eq(st.merchant_id, scope.merchantId)] : []),
          ),
        )
        .limit(1);
      const store = storeRows[0];
      if (!store) throw new ProductValidationError(`Store "${input.store_id}" not found`);

      const planIds = dedupe(input.plan_template_ids ?? []);
      if (planIds.length) await this.assertPlanTemplates(tx, planIds);

      const inserted = await tx
        .insert(p)
        .values({
          store_id: store.id,
          merchant_id: store.merchant_id,
          category_id: input.category_id,
          title: input.title,
          description: input.description,
          status: input.status ?? 'draft',
          base_price_pesewas: input.base_price_pesewas,
          compare_at_price_pesewas: input.compare_at_price_pesewas ?? null,
          deal_ends_at: input.deal_ends_at ?? null,
          attributes: input.attributes ?? {},
        })
        .returning({ id: p.id });
      const productId = inserted[0]!.id;

      // The order they were sent in IS the seller's order — S, M, L, XL — and
      // it is the only place that information exists.
      const variants = input.variants ?? [];
      for (let i = 0; i < variants.length; i += 1) {
        await this.insertVariantTx(tx, productId, variants[i]!, i);
      }
      if (input.images?.length) {
        await tx.insert(pi).values(
          input.images.map((img) => ({
            product_id: productId,
            storage_key: img.storage_key,
            alt_text: img.alt_text,
            position: img.position ?? 0,
          })),
        );
      }
      if (planIds.length) {
        await tx
          .insert(ppo)
          .values(planIds.map((tid) => ({ product_id: productId, plan_template_id: tid })));
      }

      await this.audit.append(tx, {
        entityType: 'product',
        entityId: productId,
        eventType: 'product.created',
        toState: input.status ?? 'draft',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { store_id: store.id, merchant_id: store.merchant_id },
      });

      return productId;
    });

    return this.getWithDetails(id, scope);
  }

  async list(rawInput: unknown = {}): Promise<Product[]> {
    const input: ListProductsInput = listProductsSchema.parse(rawInput);
    const where = [isNull(p.deleted_at)];
    if (input.store_id) where.push(eq(p.store_id, input.store_id));
    if (input.merchant_id) where.push(eq(p.merchant_id, input.merchant_id));
    if (input.category_id) where.push(eq(p.category_id, input.category_id));
    if (input.status) where.push(eq(p.status, input.status));
    if (input.needs_restock) {
      // EXISTS rather than a join: a product with three empty sizes must appear
      // once, not three times, and a join would need a DISTINCT that fights the
      // ORDER BY. Only ACTIVE variants count — telling a seller to restock a
      // size they have retired is noise that trains them to ignore the filter.
      where.push(sql`EXISTS (
        SELECT 1
        FROM product_variants v
        LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.product_id = ${p.id}
          AND v.is_active
          AND coalesce(i.quantity_available, 0) = 0
      )`);
    }
    return (
      this.db
        .select(productCols)
        .from(p)
        .where(and(...where))
        // `created_at` alone is not a total order — it defaults to NOW(), which
        // is transaction-start time, so a bulk upload stamps one value across
        // every row. LIMIT/OFFSET over ties lets a product appear on two pages
        // and on none. See merchant-paging.integration.spec.ts.
        .orderBy(desc(p.created_at), desc(p.id))
        .limit(input.limit)
        .offset(input.offset)
    );
  }

  /**
   * A merchant's catalogue at a glance: how many products, how many are live,
   * and how many variants a customer currently cannot buy.
   *
   * One query rather than the home screen paging through the whole catalogue to
   * count. `outOfStockVariants` is the number the app acts on — every one of
   * them is a size a shopper is being shown nothing for — and `lowStockVariants`
   * uses each variant's own `restock_threshold`, which is what the seller set it
   * for.
   *
   * Only active variants of undeleted products count. A draft product is not
   * hiding anything from anybody, and telling a merchant to restock a variant
   * they have retired is noise that trains them to ignore the row.
   */
  async summaryForMerchant(merchantId: string): Promise<MerchantCatalogSummary> {
    const [products] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        live: sql<number>`count(*) FILTER (WHERE ${p.status} = 'active')::int`,
      })
      .from(p)
      .where(and(eq(p.merchant_id, merchantId), isNull(p.deleted_at)));

    const [variants] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        outOfStock: sql<number>`count(*) FILTER (WHERE coalesce(${inv.quantity_available}, 0) = 0)::int`,
        // Strictly above zero: a variant with none left is out of stock, not
        // low, and counting it in both would double-report the same problem.
        lowStock: sql<number>`count(*) FILTER (
          WHERE coalesce(${inv.quantity_available}, 0) > 0
            AND coalesce(${inv.quantity_available}, 0) <= coalesce(${inv.restock_threshold}, 0)
        )::int`,
      })
      .from(pv)
      .innerJoin(p, eq(pv.product_id, p.id))
      .leftJoin(inv, eq(inv.variant_id, pv.id))
      .where(and(eq(p.merchant_id, merchantId), isNull(p.deleted_at), eq(pv.is_active, true)));

    return {
      products: products?.total ?? 0,
      liveProducts: products?.live ?? 0,
      variants: variants?.total ?? 0,
      outOfStockVariants: variants?.outOfStock ?? 0,
      lowStockVariants: variants?.lowStock ?? 0,
    };
  }

  /**
   * Every active variant of several products, with what is on the shelf.
   *
   * For the seller's catalogue, where a card shows its own sizes and their
   * stock. `getWithDetails` already returns this for ONE product; a list of
   * thirty cards calling it thirty times is thirty-one round trips on a
   * Ghanaian mobile connection, which is the difference between a screen and a
   * spinner.
   *
   * `quantity_available` is left-joined and coalesced because a variant created
   * without an initial stock figure has no `inventory` row at all — and a
   * missing row means none on the shelf, not unknown.
   */
  async variantsForProducts(productIds: string[]): Promise<Map<string, ProductVariantStock[]>> {
    const byProduct = new Map<string, ProductVariantStock[]>();
    if (productIds.length === 0) return byProduct;

    const rows = await this.db
      .select({
        id: pv.id,
        product_id: pv.product_id,
        sku: pv.sku,
        option_values: pv.option_values,
        price_pesewas: pv.price_pesewas,
        quantity_available: sql<number>`coalesce(${inv.quantity_available}, 0)::int`,
        restock_threshold: sql<number>`coalesce(${inv.restock_threshold}, 0)::int`,
      })
      .from(pv)
      .leftJoin(inv, eq(inv.variant_id, pv.id))
      .where(and(inArray(pv.product_id, productIds), eq(pv.is_active, true)))
      // `position` is the seller's own order, written at insert. `id` is the
      // tiebreak for rows backfilled to the same position by 0021 — every
      // variant of a product shares `created_at` (one transaction), so without
      // a tiebreak the size chips would reorder themselves between reads.
      .orderBy(asc(pv.position), asc(pv.id));

    for (const row of rows) {
      const bucket = byProduct.get(row.product_id);
      const variant: ProductVariantStock = {
        id: row.id,
        sku: row.sku,
        option_values: (row.option_values ?? {}) as Record<string, unknown>,
        price_pesewas: row.price_pesewas,
        quantity_available: Number(row.quantity_available),
        restock_threshold: Number(row.restock_threshold),
      };
      if (bucket) bucket.push(variant);
      else byProduct.set(row.product_id, [variant]);
    }
    return byProduct;
  }

  /**
   * The first image key for each of several products, in one query.
   *
   * For a catalogue list, where a seller scanning thirty rows wants to see the
   * photograph rather than read the title. Kept out of {@link list} because the
   * storefront and the admin console both call it and neither wants the extra
   * round trip; kept out of a per-row lookup because thirty rows would be
   * thirty queries.
   */
  async primaryImageKeys(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.db
      .select({ product_id: pi.product_id, storage_key: pi.storage_key })
      .from(pi)
      .where(inArray(pi.product_id, productIds))
      .orderBy(pi.position, pi.created_at);
    const first = new Map<string, string>();
    for (const row of rows) {
      if (!first.has(row.product_id)) first.set(row.product_id, row.storage_key);
    }
    return first;
  }

  /** Public full-text search over active products (title weighted above body). */
  async search(rawInput: unknown): Promise<Product[]> {
    const input: SearchProductsInput = searchProductsSchema.parse(rawInput);
    const query = sql`plainto_tsquery('english', ${input.q})`;
    return (
      this.db
        .select(productCols)
        .from(p)
        .where(and(eq(p.status, 'active'), isNull(p.deleted_at), sql`${p.search_tsv} @@ ${query}`))
        // Rank ties are the norm, not the exception, and `created_at` behind it
        // ties too — so this page needs a unique final term like any other.
        .orderBy(sql`ts_rank(${p.search_tsv}, ${query}) DESC`, desc(p.created_at), desc(p.id))
        .limit(input.limit)
        .offset(input.offset)
    );
  }

  async get(id: string, scope: ProductScope = {}): Promise<Product> {
    const rows = await this.db
      .select(productCols)
      .from(p)
      .where(and(eq(p.id, id), isNull(p.deleted_at), ...ownedBy(scope)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ProductNotFoundError(id);
    return row;
  }

  async getWithDetails(id: string, scope: ProductScope = {}): Promise<ProductDetails> {
    // Scoped once, here: everything below is keyed on a product id this caller
    // has already been shown to own.
    const product = await this.get(id, scope);

    const variantRows = await this.db
      .select()
      .from(pv)
      .leftJoin(inv, eq(inv.variant_id, pv.id))
      .where(eq(pv.product_id, id))
      // The seller's own order — see 0021. Every variant of a product shares
      // `created_at`, so ordering by it was arbitrary.
      .orderBy(asc(pv.position), asc(pv.id));
    const images = await this.db
      .select()
      .from(pi)
      .where(eq(pi.product_id, id))
      .orderBy(pi.position);
    const offers = await this.db
      .select({ plan_template_id: ppo.plan_template_id })
      .from(ppo)
      .where(and(eq(ppo.product_id, id), eq(ppo.is_active, true)));

    return {
      ...product,
      variants: variantRows.map((r) => ({ ...r.product_variants, inventory: r.inventory })),
      images,
      plan_template_ids: offers.map((o) => o.plan_template_id),
    };
  }

  async update(
    id: string,
    rawPatch: unknown,
    actor: ProductActor,
    scope: ProductScope = {},
  ): Promise<Product> {
    const patch: UpdateProductInput = updateProductSchema.parse(rawPatch);

    return runInTransaction(this.db, async (tx) => {
      /**
       * The sale rules, checked against the row this patch would PRODUCE.
       *
       * A schema cannot do this one. Raising `base_price_pesewas` past a
       * `compare_at_price_pesewas` the patch never mentions is a perfectly
       * valid patch and an invalid row, and so is clearing the "was" price of
       * a product whose sale is still running. Without the merge, both reach
       * Postgres, trip `products_compare_at_above_price` or
       * `products_deal_needs_compare_at`, and come back as a 500 — a seller's
       * typo reported as our fault.
       *
       * Locked because the row is read and then written on the strength of
       * what was read.
       */
      const current = await tx
        .select({
          base_price_pesewas: p.base_price_pesewas,
          compare_at_price_pesewas: p.compare_at_price_pesewas,
          deal_ends_at: p.deal_ends_at,
        })
        .from(p)
        .where(and(eq(p.id, id), isNull(p.deleted_at), ...ownedBy(scope)))
        .for('update')
        .limit(1);
      if (!current[0]) throw new ProductNotFoundError(id);

      const dealIssue = dealRuleIssue({ ...current[0], ...patch });
      if (dealIssue) throw new ProductValidationError(dealIssue);

      const rows = await tx
        .update(p)
        .set({ ...patch })
        .where(and(eq(p.id, id), isNull(p.deleted_at), ...ownedBy(scope)))
        .returning(productCols);
      const row = rows[0];
      if (!row) throw new ProductNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'product',
        entityId: id,
        eventType: 'product.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });

      return row;
    });
  }

  async addVariant(
    productId: string,
    rawInput: unknown,
    actor: ProductActor,
    scope: ProductScope = {},
  ): Promise<ProductVariant> {
    const input: AddVariantInput = addVariantSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId, scope);
      // Onto the end. `max + 1` and not `count`, so a variant added after one
      // was deleted does not collide with an existing position.
      const [last] = await tx
        .select({ highest: sql<number | null>`max(${pv.position})` })
        .from(pv)
        .where(eq(pv.product_id, productId));
      const variantId = await this.insertVariantTx(
        tx,
        productId,
        input,
        last?.highest === null || last?.highest === undefined ? 0 : Number(last.highest) + 1,
      );
      await this.audit.append(tx, {
        entityType: 'product',
        entityId: productId,
        eventType: 'product.variant_added',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { variant_id: variantId, sku: input.sku },
      });
      const rows = await tx.select().from(pv).where(eq(pv.id, variantId)).limit(1);
      return rows[0]!;
    });
  }

  async addImage(
    productId: string,
    rawInput: unknown,
    actor: ProductActor,
    scope: ProductScope = {},
  ): Promise<ProductImage> {
    const input: AddImageInput = addImageSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId, scope);
      const rows = await tx
        .insert(pi)
        .values({
          product_id: productId,
          storage_key: input.storage_key,
          alt_text: input.alt_text,
          position: input.position ?? 0,
        })
        .returning();
      await this.audit.append(tx, {
        entityType: 'product',
        entityId: productId,
        eventType: 'product.image_added',
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      return rows[0]!;
    });
  }

  /** Replaces the product's installment plan offers with exactly `plan_template_ids`. */
  async setPlanOffers(
    productId: string,
    rawInput: unknown,
    actor: ProductActor,
    scope: ProductScope = {},
  ): Promise<string[]> {
    const input: SetPlanOffersInput = setPlanOffersSchema.parse(rawInput);
    const planIds = dedupe(input.plan_template_ids);

    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId, scope);
      if (planIds.length) await this.assertPlanTemplates(tx, planIds);

      await tx.delete(ppo).where(eq(ppo.product_id, productId));
      if (planIds.length) {
        await tx
          .insert(ppo)
          .values(planIds.map((tid) => ({ product_id: productId, plan_template_id: tid })));
      }

      await this.audit.append(tx, {
        entityType: 'product',
        entityId: productId,
        eventType: 'product.plan_offers_set',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { plan_template_ids: planIds },
      });

      return planIds;
    });
  }

  // ------------------------------------------------------------- internal

  /**
   * @param position Where this variant sits among the product's own.
   *
   * Passed in rather than derived, because the two callers know different
   * things: creating a product knows the whole list and its index, while
   * `addVariant` has to look up what is already there. Both must supply one —
   * a product's variants are inserted in ONE transaction, so `created_at` is
   * the transaction's start time for every row and cannot separate them.
   */
  private async insertVariantTx(
    tx: Pick<Database, 'insert'>,
    productId: string,
    v: VariantInput,
    position: number,
  ): Promise<string> {
    let variantId: string;
    try {
      const rows = await tx
        .insert(pv)
        .values({
          product_id: productId,
          sku: v.sku,
          option_values: v.option_values ?? {},
          price_pesewas: v.price_pesewas ?? null,
          barcode: v.barcode,
          position,
        })
        .returning({ id: pv.id });
      variantId = rows[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err, 'product_variants_product_id_sku_key')) {
        throw new ProductConflictError(`SKU "${v.sku}" already exists for this product`);
      }
      throw err;
    }
    await tx
      .insert(inv)
      .values({ variant_id: variantId, quantity_available: v.quantity_available ?? 0 });
    return variantId;
  }

  private async assertProduct(
    tx: Pick<Database, 'select'>,
    id: string,
    scope: ProductScope = {},
  ): Promise<void> {
    const rows = await tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.id, id), isNull(p.deleted_at), ...ownedBy(scope)))
      .limit(1);
    if (!rows[0]) throw new ProductNotFoundError(id);
  }

  private async assertPlanTemplates(tx: Pick<Database, 'select'>, ids: string[]): Promise<void> {
    const found = await tx.select({ id: pt.id }).from(pt).where(inArray(pt.id, ids));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length) {
      throw new ProductValidationError(`Unknown plan_template_id(s): ${missing.join(', ')}`);
    }
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Spreadable so an unscoped (admin) call adds nothing to the WHERE at all. */
function ownedBy(scope: ProductScope) {
  return scope.merchantId ? [eq(p.merchant_id, scope.merchantId)] : [];
}
