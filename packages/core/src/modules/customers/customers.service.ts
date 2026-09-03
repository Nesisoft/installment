import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger, type AuditActorType } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  attachGhanaCardSchema,
  listCustomersSchema,
  recordConsentSchema,
  registerCustomerSchema,
  rejectGhanaCardSchema,
  setBlocklistSchema,
  setMomoSchema,
  updateCustomerSchema,
  type AttachGhanaCardInput,
  type ConsentType,
  type ListCustomersInput,
  type RegisterCustomerInput,
  type RejectGhanaCardInput,
  type SetBlocklistInput,
  type SetMomoInput,
  type UpdateCustomerInput,
} from './dto';
import {
  CustomerNotFoundError,
  GhanaCardNotAttachedError,
  GhanaCardVerificationFailedError,
} from './errors';
import type { GhanaCardVerifier } from './ghana-card-verifier';

const c = schema.customers;

export type Customer = typeof schema.customers.$inferSelect;

export interface CustomerActor {
  actorId: string;
  actorType: AuditActorType;
}

const CONSENT_COLUMN: Record<ConsentType, keyof typeof c.$inferInsert> = {
  data_processing: 'data_processing_consent_at',
  credit_scoring: 'credit_scoring_consent_at',
  marketing: 'marketing_consent_at',
};

export class CustomersService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    private readonly ghanaCardVerifier: GhanaCardVerifier,
  ) {}

  // ----------------------------------------------------------------- register

  async register(rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const input: RegisterCustomerInput = registerCustomerSchema.parse(rawInput);
    const now = new Date().toISOString();

    return runInTransaction(this.db, async (tx) => {
      const [row] = await tx
        .insert(c)
        .values({
          first_name: input.first_name,
          last_name: input.last_name,
          email: input.email,
          phone: input.phone,
          date_of_birth: input.date_of_birth,
          metadata: input.metadata ?? {},
          data_processing_consent_at: input.consents?.data_processing ? now : null,
          credit_scoring_consent_at: input.consents?.credit_scoring ? now : null,
          marketing_consent_at: input.consents?.marketing ? now : null,
        })
        .returning();
      if (!row) throw new Error('customer insert returned no row');

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: row.id,
        eventType: 'customer.registered',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { email: row.email, phone: row.phone },
      });

      return row;
    });
  }

  // ---------------------------------------------------------------------- list

  async list(rawInput: unknown = {}): Promise<Customer[]> {
    const input: ListCustomersInput = listCustomersSchema.parse(rawInput);
    const where = [isNull(c.deleted_at)];
    if (input.kyc_tier !== undefined) where.push(eq(c.kyc_tier, input.kyc_tier));
    if (input.is_on_blocklist !== undefined) {
      where.push(eq(c.is_on_blocklist, input.is_on_blocklist));
    }
    return this.db
      .select()
      .from(c)
      .where(and(...where))
      .orderBy(desc(c.created_at))
      .limit(input.limit)
      .offset(input.offset);
  }

  // ----------------------------------------------------------------------- get

  async get(id: string): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(c)
      .where(and(eq(c.id, id), isNull(c.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new CustomerNotFoundError(id);
    return row;
  }

  /** Resolve the customer linked to an authenticated login (users.id). */
  /** Lookup by (canonicalised) phone — customers.phone is unique. */
  async findByPhone(phone: string): Promise<Customer | undefined> {
    const rows = await this.db
      .select()
      .from(c)
      .where(and(eq(c.phone, phone), isNull(c.deleted_at)))
      .limit(1);
    return rows[0];
  }

  async findByUserId(userId: string): Promise<Customer | undefined> {
    const rows = await this.db
      .select()
      .from(c)
      .where(and(eq(c.user_id, userId), isNull(c.deleted_at)))
      .limit(1);
    return rows[0];
  }

  // --------------------------------------------------------------------- update

  async update(id: string, rawPatch: unknown, actor: CustomerActor): Promise<Customer> {
    const patch: UpdateCustomerInput = updateCustomerSchema.parse(rawPatch);
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(c)
        .set({ ...patch })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.updated',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { fields: Object.keys(patch) },
      });
      return row;
    });
  }

  // ----------------------------------------------------------- attachGhanaCard

  async attachGhanaCard(id: string, rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const input: AttachGhanaCardInput = attachGhanaCardSchema.parse(rawInput);

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(c)
        .set({
          ghana_card_number: input.ghana_card_number,
          ghana_card_image_key: input.ghana_card_image_key,
          // Re-attaching invalidates any prior verification.
          ghana_card_verified: false,
          ghana_card_verified_at: null,
        })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.ghana_card_attached',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { ghana_card_number: input.ghana_card_number },
      });
      return row;
    });
  }

  // ---------------------------------------------------------- verifyGhanaCard

  async verifyGhanaCard(id: string, actor: CustomerActor): Promise<Customer> {
    const current = await this.get(id);
    if (!current.ghana_card_number || !current.ghana_card_image_key) {
      throw new GhanaCardNotAttachedError(id);
    }

    const result = await this.ghanaCardVerifier.verify({
      ghana_card_number: current.ghana_card_number,
      ghana_card_image_key: current.ghana_card_image_key,
    });

    if (!result.verified) {
      // Audit the failure on the root connection — wrapping it in
      // runInTransaction together with the throw would roll the row back.
      await this.audit.append(this.db, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.ghana_card_verification_failed',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: result.reason,
        metadata: { raw: result.raw },
      });
      throw new GhanaCardVerificationFailedError(result.reason);
    }

    return runInTransaction(this.db, async (tx) => {
      const nowIso = new Date().toISOString();
      const previousTier = current.kyc_tier;
      const newTier = previousTier < 1 ? 1 : previousTier;

      const rows = await tx
        .update(c)
        .set({
          ghana_card_verified: true,
          ghana_card_verified_at: nowIso,
          kyc_tier: newTier,
        })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.ghana_card_verified',
        fromState: `kyc_tier=${previousTier}`,
        toState: `kyc_tier=${newTier}`,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { raw: result.raw },
      });
      return row;
    });
  }

  // ---------------------------------------------------------- rejectGhanaCard

  /**
   * The other half of a review. Before this, a reviewer who opened a scan and
   * found it unreadable, expired or someone else's had nowhere to say so — they
   * closed the tab, and the next reviewer started from the same blank slate.
   *
   * Rejecting withdraws any verification the card had won and takes the KYC tier
   * back down with it, because that tier was raised by this card and nothing
   * else raises it. The number and image key stay on the row: they are what was
   * rejected, and re-attaching is what replaces them.
   */
  async rejectGhanaCard(id: string, rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const input: RejectGhanaCardInput = rejectGhanaCardSchema.parse(rawInput);
    const current = await this.get(id);
    if (!current.ghana_card_number || !current.ghana_card_image_key) {
      throw new GhanaCardNotAttachedError(id);
    }

    return runInTransaction(this.db, async (tx) => {
      const previousTier = current.kyc_tier;
      const newTier = previousTier === 1 ? 0 : previousTier;

      const rows = await tx
        .update(c)
        .set({
          ghana_card_verified: false,
          ghana_card_verified_at: null,
          kyc_tier: newTier,
        })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.ghana_card_rejected',
        fromState: `kyc_tier=${previousTier}`,
        toState: `kyc_tier=${newTier}`,
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: input.reason,
        metadata: { ghana_card_number: current.ghana_card_number },
      });
      return row;
    });
  }

  // ----------------------------------------------------------------- setMomo

  async setMomo(id: string, rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const input: SetMomoInput = setMomoSchema.parse(rawInput);
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(c)
        .set({ momo_phone: input.momo_phone, momo_provider: input.momo_provider })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.momo_set',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { momo_provider: input.momo_provider },
      });
      return row;
    });
  }

  // ----------------------------------------------------------- record consent

  async recordConsent(id: string, rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const { type } = recordConsentSchema.parse(rawInput);
    const column = CONSENT_COLUMN[type];
    const nowIso = new Date().toISOString();

    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(c)
        .set({ [column]: nowIso })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: 'customer.consent_recorded',
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: { consent: type },
      });
      return row;
    });
  }

  // ------------------------------------------------------------- blocklist

  async setBlocklist(id: string, rawInput: unknown, actor: CustomerActor): Promise<Customer> {
    const input: SetBlocklistInput = setBlocklistSchema.parse(rawInput);
    return this.changeBlocklist(id, true, input.reason, actor);
  }

  async removeBlocklist(id: string, actor: CustomerActor): Promise<Customer> {
    return this.changeBlocklist(id, false, null, actor);
  }

  private async changeBlocklist(
    id: string,
    flag: boolean,
    reason: string | null,
    actor: CustomerActor,
  ): Promise<Customer> {
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(c)
        .set({ is_on_blocklist: flag, blocklist_reason: reason })
        .where(and(eq(c.id, id), isNull(c.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new CustomerNotFoundError(id);

      await this.audit.append(tx, {
        entityType: 'customer',
        entityId: id,
        eventType: flag ? 'customer.blocklisted' : 'customer.unblocked',
        actorId: actor.actorId,
        actorType: actor.actorType,
        reason: reason ?? undefined,
      });
      return row;
    });
  }
}
