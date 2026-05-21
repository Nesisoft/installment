import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  attachPaystackRecipientSchema,
  createMerchantSchema,
  listMerchantsSchema,
  transitionMerchantSchema,
  updateMerchantSchema,
  type AttachPaystackRecipientInput,
  type CreateMerchantInput,
  type ListMerchantsInput,
  type TransitionMerchantInput,
  type UpdateMerchantInput,
} from './dto';
import { MerchantConflictError, MerchantNotFoundError } from './errors';
import { nextMerchantStatus, type MerchantEvent, type MerchantStatus } from './state-machine';

const m = schema.merchants;

export type Merchant = typeof schema.merchants.$inferSelect;

export interface MerchantActor {
  /** SYSTEM_ACTORS.* UUID, a real user UUID, or — for webhooks — a string like 'paystack'. */
  actorId: string;
  actorType: AuditActorType;
}

export class MerchantsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
  ) {}

  // --------------------------------------------------------------------- create

  async create(rawInput: unknown, actor: MerchantActor): Promise<Merchant> {
    const input: CreateMerchantInput = createMerchantSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const [row] = await tx
        .insert(m)
        .values({
          business_name: input.business_name,
          legal_name: input.legal_name,
          email: input.email,
          phone: input.phone,
          tin: input.tin,
          registration_number: input.registration_number,
          default_business_model: input.default_business_model,
          default_mdr_bps: input.default_mdr_bps,
          default_reserve_bps: input.default_reserve_bps,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) throw new Error('merchant insert returned no row');

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: row.id,
        eventType: 'merchant.created',
        toState: row.status,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { email: row.email },
      });

      return row;
    });
  }

  // ---------------------------------------------------------------------- list

  async list(rawInput: unknown = {}): Promise<Merchant[]> {
    const input: ListMerchantsInput = listMerchantsSchema.parse(rawInput);
    const whereClauses = [isNull(m.deleted_at)];
    if (input.status) whereClauses.push(eq(m.status, input.status));
    return this.db
      .select()
      .from(m)
      .where(and(...whereClauses))
      .orderBy(desc(m.created_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  // ----------------------------------------------------------------------- get

  async get(id: string): Promise<Merchant> {
    const rows = await this.db
      .select()
      .from(m)
      .where(and(eq(m.id, id), isNull(m.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new MerchantNotFoundError(id);
    return row;
  }

  // --------------------------------------------------------------------- update

  async update(id: string, rawPatch: unknown, actor: MerchantActor): Promise<Merchant> {
    const patch: UpdateMerchantInput = updateMerchantSchema.parse(rawPatch);

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(m)
        .set({
          ...patch,
          metadata: patch.metadata,
        })
        .where(and(eq(m.id, id), isNull(m.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new MerchantNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: id,
        eventType: 'merchant.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });

      return row;
    });
  }

  // ----------------------------------------------------------------- transition

  async transition(id: string, rawInput: unknown, actor: MerchantActor): Promise<Merchant> {
    const { event, reason }: TransitionMerchantInput = transitionMerchantSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const current = await this.loadWithLock(tx, id);
      const from = current.status as MerchantStatus;
      const to = nextMerchantStatus(from, event as MerchantEvent);

      const nowIso = new Date().toISOString();
      const patch: Partial<typeof m.$inferInsert> = { status: to };

      if (to === 'active') {
        // First activation sets onboarded_at; reactivation clears suspension fields.
        if (!current.onboarded_at) patch.onboarded_at = nowIso;
        patch.suspended_at = null;
        patch.suspension_reason = null;
      } else if (to === 'suspended') {
        patch.suspended_at = nowIso;
        patch.suspension_reason = reason ?? null;
      }

      // Optimistic guard on current status — protects against a concurrent
      // transition by another caller.
      const rows = await tx
        .update(m)
        .set(patch)
        .where(and(eq(m.id, id), eq(m.status, from), isNull(m.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new MerchantConflictError(
          `Concurrent transition detected for merchant "${id}" (expected status "${from}")`,
        );
      }

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: id,
        eventType: `merchant.${event}`,
        fromState: from,
        toState: to,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason,
      });

      return row;
    });
  }

  // ---------------------------------------------------- attachPaystackRecipient

  async attachPaystackRecipient(
    id: string,
    rawInput: unknown,
    actor: MerchantActor,
  ): Promise<Merchant> {
    const input: AttachPaystackRecipientInput = attachPaystackRecipientSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(m)
        .set({
          paystack_recipient_code: input.paystack_recipient_code,
          bank_account_number: input.bank_account_number,
          bank_code: input.bank_code,
          bank_account_name: input.bank_account_name,
        })
        .where(and(eq(m.id, id), isNull(m.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new MerchantNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: id,
        eventType: 'merchant.paystack_recipient_attached',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { paystack_recipient_code: input.paystack_recipient_code },
      });

      return row;
    });
  }

  // -------------------------------------------------------------- internal helpers

  private async loadWithLock(tx: Pick<Database, 'select'>, id: string): Promise<Merchant> {
    const rows = await tx
      .select()
      .from(m)
      .where(and(eq(m.id, id), isNull(m.deleted_at)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) throw new MerchantNotFoundError(id);
    return row;
  }
}
