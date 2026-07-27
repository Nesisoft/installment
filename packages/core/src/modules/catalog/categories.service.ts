import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { isUniqueViolation } from '../../shared/db/pg-errors';
import {
  createCategorySchema,
  listCategoriesSchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type ListCategoriesInput,
  type UpdateCategoryInput,
} from './dto';
import { CategoryConflictError, CategoryNotFoundError, CategoryValidationError } from './errors';

const c = schema.categories;

export type Category = typeof schema.categories.$inferSelect;

export interface CategoryActor {
  actorId: string;
  actorType: AuditActorType;
}

/**
 * The marketplace category taxonomy — a self-referential tree, admin-curated
 * (moderation). Categories are never hard-deleted; `is_active = false` retires
 * one while keeping historical product references intact.
 */
export class CategoriesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  async create(rawInput: unknown, actor: CategoryActor): Promise<Category> {
    const input: CreateCategoryInput = createCategorySchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      if (input.parent_id) await this.assertExists(tx, input.parent_id);

      let row: Category;
      try {
        const inserted = await tx
          .insert(c)
          .values({
            name: input.name,
            slug: input.slug,
            parent_id: input.parent_id,
            position: input.position,
          })
          .returning();
        row = inserted[0]!;
      } catch (err) {
        if (isUniqueViolation(err, 'categories_slug_key')) {
          throw new CategoryConflictError(`Category slug "${input.slug}" is already taken`);
        }
        throw err;
      }

      await this.audit.append(tx, {
        entityType: 'category',
        entityId: row.id,
        eventType: 'category.created',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { slug: row.slug, parent_id: row.parent_id },
      });

      return row;
    });
  }

  async list(rawInput: unknown = {}): Promise<Category[]> {
    const input: ListCategoriesInput = listCategoriesSchema.parse(rawInput);
    const where = [];
    if (input.parent_id) where.push(eq(c.parent_id, input.parent_id));
    else if (input.top_level) where.push(isNull(c.parent_id));
    if (input.active_only) where.push(eq(c.is_active, true));
    return this.db
      .select()
      .from(c)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(c.position), asc(c.name))
      .limit(input.limit)
      .offset(input.offset);
  }

  async get(id: string): Promise<Category> {
    const rows = await this.db.select().from(c).where(eq(c.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new CategoryNotFoundError(id);
    return row;
  }

  async getBySlug(slug: string): Promise<Category> {
    const rows = await this.db.select().from(c).where(eq(c.slug, slug)).limit(1);
    const row = rows[0];
    if (!row) throw new CategoryNotFoundError(slug);
    return row;
  }

  async update(id: string, rawPatch: unknown, actor: CategoryActor): Promise<Category> {
    const patch: UpdateCategoryInput = updateCategorySchema.parse(rawPatch);
    if (patch.parent_id === id) {
      throw new CategoryValidationError('A category cannot be its own parent');
    }

    return runInTransaction(this.db, async (tx) => {
      if (patch.parent_id) await this.assertExists(tx, patch.parent_id);

      let row: Category | undefined;
      try {
        const rows = await tx
          .update(c)
          .set({ ...patch })
          .where(eq(c.id, id))
          .returning();
        row = rows[0];
      } catch (err) {
        if (isUniqueViolation(err, 'categories_slug_key')) {
          throw new CategoryConflictError(`Category slug "${patch.slug}" is already taken`);
        }
        throw err;
      }
      if (!row) throw new CategoryNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'category',
        entityId: id,
        eventType: 'category.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });

      return row;
    });
  }

  private async assertExists(tx: Pick<Database, 'select'>, id: string): Promise<void> {
    const rows = await tx.select({ id: c.id }).from(c).where(eq(c.id, id)).limit(1);
    if (!rows[0]) throw new CategoryValidationError(`Parent category "${id}" does not exist`);
  }
}
