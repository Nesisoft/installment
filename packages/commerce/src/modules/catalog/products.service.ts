import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
const productCols = {
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
 * Products and their nested variants / images / installment plan offers, plus
 * the inventory row bootstrapped per variant. `create` accepts the whole
 * "upload a product" payload in one transaction (roadmap Phase 11 DoD).
 */
export class ProductsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(rawInput: unknown, actor: ProductActor): Promise<ProductDetails> {
    const input: CreateProductInput = createProductSchema.parse(rawInput);

    const id = await runInTransaction(this.db, async (tx) => {
      const storeRows = await tx
        .select({ id: st.id, merchant_id: st.merchant_id })
        .from(st)
        .where(and(eq(st.id, input.store_id), isNull(st.deleted_at)))
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
          attributes: input.attributes ?? {},
        })
        .returning({ id: p.id });
      const productId = inserted[0]!.id;

      for (const variant of input.variants ?? []) {
        await this.insertVariantTx(tx, productId, variant);
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

    return this.getWithDetails(id);
  }

  async list(rawInput: unknown = {}): Promise<Product[]> {
    const input: ListProductsInput = listProductsSchema.parse(rawInput);
    const where = [isNull(p.deleted_at)];
    if (input.store_id) where.push(eq(p.store_id, input.store_id));
    if (input.merchant_id) where.push(eq(p.merchant_id, input.merchant_id));
    if (input.category_id) where.push(eq(p.category_id, input.category_id));
    if (input.status) where.push(eq(p.status, input.status));
    return this.db
      .select(productCols)
      .from(p)
      .where(and(...where))
      .orderBy(desc(p.created_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  /** Public full-text search over active products (title weighted above body). */
  async search(rawInput: unknown): Promise<Product[]> {
    const input: SearchProductsInput = searchProductsSchema.parse(rawInput);
    const query = sql`plainto_tsquery('english', ${input.q})`;
    return this.db
      .select(productCols)
      .from(p)
      .where(and(eq(p.status, 'active'), isNull(p.deleted_at), sql`${p.search_tsv} @@ ${query}`))
      .orderBy(sql`ts_rank(${p.search_tsv}, ${query}) DESC`, desc(p.created_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  async get(id: string): Promise<Product> {
    const rows = await this.db
      .select(productCols)
      .from(p)
      .where(and(eq(p.id, id), isNull(p.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ProductNotFoundError(id);
    return row;
  }

  async getWithDetails(id: string): Promise<ProductDetails> {
    const product = await this.get(id);

    const variantRows = await this.db
      .select()
      .from(pv)
      .leftJoin(inv, eq(inv.variant_id, pv.id))
      .where(eq(pv.product_id, id))
      .orderBy(pv.created_at);
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

  async update(id: string, rawPatch: unknown, actor: ProductActor): Promise<Product> {
    const patch: UpdateProductInput = updateProductSchema.parse(rawPatch);

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(p)
        .set({ ...patch })
        .where(and(eq(p.id, id), isNull(p.deleted_at)))
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
  ): Promise<ProductVariant> {
    const input: AddVariantInput = addVariantSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId);
      const variantId = await this.insertVariantTx(tx, productId, input);
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

  async addImage(productId: string, rawInput: unknown, actor: ProductActor): Promise<ProductImage> {
    const input: AddImageInput = addImageSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId);
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
  ): Promise<string[]> {
    const input: SetPlanOffersInput = setPlanOffersSchema.parse(rawInput);
    const planIds = dedupe(input.plan_template_ids);

    return runInTransaction(this.db, async (tx) => {
      await this.assertProduct(tx, productId);
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

  private async insertVariantTx(
    tx: Pick<Database, 'insert'>,
    productId: string,
    v: VariantInput,
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

  private async assertProduct(tx: Pick<Database, 'select'>, id: string): Promise<void> {
    const rows = await tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.id, id), isNull(p.deleted_at)))
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
