import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  AuditLogger,
  type AuditActorType,
  runInTransaction,
  isUniqueViolation,
} from '@installment/core';
import {
  createStoreSchema,
  listStoresSchema,
  transitionStoreSchema,
  updateStoreSchema,
  type CreateStoreInput,
  type ListStoresInput,
  type TransitionStoreInput,
  type UpdateStoreInput,
} from './dto';
import {
  StoreConflictError,
  StoreNotFoundError,
  StoreTransitionError,
  UnknownStoreCategoryError,
} from './errors';

const s = schema.stores;
const cat = schema.categories;

export type Store = typeof schema.stores.$inferSelect;
export type StoreStatus = (typeof schema.stores.$inferSelect)['status'];

export interface StoreActor {
  actorId: string;
  actorType: AuditActorType;
}

/** Legal store status transitions: which statuses each event may fire from. */
const STORE_TRANSITIONS: Record<TransitionStoreInput['event'], { from: string[]; to: string }> = {
  activate: { from: ['draft', 'suspended'], to: 'active' },
  suspend: { from: ['draft', 'active'], to: 'suspended' },
  unsuspend: { from: ['suspended'], to: 'active' },
};

/**
 * A merchant's public storefront. One store per merchant for v1 (the
 * stores.merchant_id UNIQUE constraint enforces it). KYC / banking / payout
 * stay on `merchants`; a store is the merchant's public face.
 */
/**
 * Narrows a store operation to one merchant's own store.
 *
 * Optional because the admin surface is deliberately unscoped. When set, the
 * merchant id goes into the WHERE clause rather than a check afterwards, so
 * another merchant's store reads as one that does not exist — a 404, never a
 * 403, for the same reason as everywhere else on the scoped surface.
 */
export interface StoreScope {
  merchantId?: string;
}

export class StoresService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(rawInput: unknown, actor: StoreActor): Promise<Store> {
    const input: CreateStoreInput = createStoreSchema.parse(rawInput);
    const categoryId = await this.categoryIdFor(input.primary_category_slug);

    return runInTransaction(this.db, async (tx) => {
      let row: Store;
      try {
        const inserted = await tx
          .insert(s)
          .values({
            merchant_id: input.merchant_id,
            slug: input.slug,
            display_name: input.display_name,
            about: input.about,
            logo_key: input.logo_key,
            banner_key: input.banner_key,
            support_email: input.support_email,
            support_phone: input.support_phone,
            primary_category_id: categoryId,
            policies: input.policies ?? {},
            metadata: input.metadata ?? {},
          })
          .returning();
        row = inserted[0]!;
      } catch (err) {
        if (isUniqueViolation(err, 'stores_merchant_id_key')) {
          throw new StoreConflictError(`Merchant "${input.merchant_id}" already has a store`);
        }
        if (isUniqueViolation(err, 'stores_slug_key')) {
          throw new StoreConflictError(`Store slug "${input.slug}" is already taken`);
        }
        throw err;
      }

      await this.audit.append(tx, {
        entityType: 'store',
        entityId: row.id,
        eventType: 'store.created',
        toState: row.status,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { merchant_id: row.merchant_id, slug: row.slug },
      });

      return row;
    });
  }

  async list(rawInput: unknown = {}): Promise<Store[]> {
    const input: ListStoresInput = listStoresSchema.parse(rawInput);
    const where = [isNull(s.deleted_at)];
    if (input.status) where.push(eq(s.status, input.status));
    if (input.merchant_id) where.push(eq(s.merchant_id, input.merchant_id));
    return this.db
      .select()
      .from(s)
      .where(and(...where))
      .orderBy(desc(s.created_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  async get(id: string): Promise<Store> {
    const rows = await this.db
      .select()
      .from(s)
      .where(and(eq(s.id, id), isNull(s.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new StoreNotFoundError(id);
    return row;
  }

  async getByMerchant(merchantId: string): Promise<Store | null> {
    const rows = await this.db
      .select()
      .from(s)
      .where(and(eq(s.merchant_id, merchantId), isNull(s.deleted_at)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Public storefront lookup — active stores only. */
  async getActiveBySlug(slug: string): Promise<Store> {
    const rows = await this.db
      .select()
      .from(s)
      .where(and(eq(s.slug, slug), eq(s.status, 'active'), isNull(s.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new StoreNotFoundError(slug);
    return row;
  }

  /**
   * Patches a store.
   *
   * `scope.merchantId` narrows it to the caller's own store by putting the
   * merchant id in the WHERE clause, so a merchant editing somebody else's
   * store gets the same not-found as for a store that does not exist. The admin
   * surface passes no scope and reaches every store, as it must.
   */
  async update(
    id: string,
    rawPatch: unknown,
    actor: StoreActor,
    scope: StoreScope = {},
  ): Promise<Store> {
    const patch: UpdateStoreInput = updateStoreSchema.parse(rawPatch);
    // The wire says `primary_category_slug`; the column is a foreign key. Pull
    // it out of the patch entirely, so an unrecognised slug fails before
    // anything is written and never reaches `.set()` as a stray column.
    const { primary_category_slug: categorySlug, ...columns } = patch;
    const categoryId =
      categorySlug === undefined ? undefined : await this.categoryIdFor(categorySlug);

    return runInTransaction(this.db, async (tx) => {
      let row: Store | undefined;
      try {
        const rows = await tx
          .update(s)
          .set({
            ...columns,
            ...(categoryId === undefined ? {} : { primary_category_id: categoryId }),
          })
          .where(
            and(
              eq(s.id, id),
              isNull(s.deleted_at),
              ...(scope.merchantId ? [eq(s.merchant_id, scope.merchantId)] : []),
            ),
          )
          .returning();
        row = rows[0];
      } catch (err) {
        if (isUniqueViolation(err, 'stores_slug_key')) {
          throw new StoreConflictError(`Store slug "${patch.slug}" is already taken`);
        }
        throw err;
      }
      if (!row) throw new StoreNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'store',
        entityId: id,
        eventType: 'store.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });

      return row;
    });
  }

  /**
   * Refuses a slug that is not a category a shop can be listed under.
   *
   * Public so signup can check before it creates anything. Without it, a bad
   * slug fails inside `provisionStore` — after the merchant and its login are
   * already committed — and the person is left with an account they cannot
   * retry into and a shop that does not exist.
   */
  async assertCategory(slug: string): Promise<void> {
    await this.categoryIdFor(slug);
  }

  /**
   * Turns a category slug into the foreign key, refusing anything that is not a
   * real top-level category.
   *
   * Top-level only, and enforced here because a foreign key cannot see
   * `parent_id`. A shop listed under "Laptops" would be invisible to anyone
   * browsing "Electronics" — the taxonomy has one level of shops and two of
   * products, and mixing them makes the shop rail wrong rather than merely
   * specific.
   */
  private async categoryIdFor(slug: string | undefined): Promise<string | undefined> {
    if (slug === undefined) return undefined;
    const rows = await this.db
      .select({ id: cat.id })
      .from(cat)
      .where(and(eq(cat.slug, slug), isNull(cat.parent_id), eq(cat.is_active, true)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new UnknownStoreCategoryError(slug);
    return row.id;
  }

  async transition(id: string, rawInput: unknown, actor: StoreActor): Promise<Store> {
    const { event, reason }: TransitionStoreInput = transitionStoreSchema.parse(rawInput);
    const rule = STORE_TRANSITIONS[event];

    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      if (!rule.from.includes(current.status)) {
        throw new StoreTransitionError(current.status, event);
      }

      const rows = await tx
        .update(s)
        .set({ status: rule.to })
        .where(and(eq(s.id, id), eq(s.status, current.status), isNull(s.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new StoreConflictError(
          `Concurrent transition detected for store "${id}" (expected status "${current.status}")`,
        );
      }

      await this.audit.append(tx, {
        entityType: 'store',
        entityId: id,
        eventType: `store.${event}`,
        fromState: current.status,
        toState: rule.to,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
      });

      return row;
    });
  }

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Store> {
    const rows = await tx
      .select()
      .from(s)
      .where(and(eq(s.id, id), isNull(s.deleted_at)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) throw new StoreNotFoundError(id);
    return row;
  }
}
