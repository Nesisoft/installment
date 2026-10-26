import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { PaymentAttemptNotFoundError } from './errors';

const pa = schema.payment_attempts;

export type PaymentAttempt = typeof schema.payment_attempts.$inferSelect;

export type PaymentProvider = 'paystack' | 'manual';
export type PaymentChannel = 'auto_debit' | 'payment_link' | 'manual_entry';
export type PaymentMethod = 'momo' | 'card' | 'bank_transfer';
export type AttemptStatus = 'in_flight' | 'unknown' | 'succeeded' | 'failed';

export interface CreateAttemptInput {
  scheduleId: string;
  customerPlanId: string;
  channel: PaymentChannel;
  amountPesewas: number;
  /** Stable per (schedule, attempt #) — a Paystack retry reuses it, never double-charging. */
  idempotencyKey: string;
  provider?: PaymentProvider;
  paymentMethod?: PaymentMethod;
  providerReference?: string;
  /** Hosted checkout URL, for the payment-link channel. */
  paymentLinkUrl?: string;
}

export interface UpdateAttemptInput {
  status?: AttemptStatus;
  providerReference?: string;
  paymentLinkUrl?: string;
  failureReason?: string;
  rawResponse?: unknown;
  settledAt?: Date;
  failedAt?: Date;
  lastVerifiedAt?: Date;
  verifyPollCount?: number;
}

/**
 * Persistence for `payment_attempts` — the durable log of every charge we try.
 * An attempt is written BEFORE Paystack is called and updated as the outcome
 * resolves (synchronously, via webhook, or via a verify poll), so a crashed
 * process never loses the fact that money may have moved.
 */
export class AttemptRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateAttemptInput): Promise<PaymentAttempt> {
    const [row] = await this.db
      .insert(pa)
      .values({
        schedule_id: input.scheduleId,
        customer_plan_id: input.customerPlanId,
        provider: input.provider ?? 'paystack',
        channel: input.channel,
        payment_method: input.paymentMethod,
        amount_pesewas: input.amountPesewas,
        idempotency_key: input.idempotencyKey,
        provider_reference: input.providerReference,
        payment_link_url: input.paymentLinkUrl,
      })
      .returning();
    if (!row) throw new Error('payment_attempts insert returned no row');
    return row;
  }

  async update(id: string, patch: UpdateAttemptInput): Promise<PaymentAttempt> {
    const set: Partial<typeof pa.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.providerReference !== undefined) set.provider_reference = patch.providerReference;
    if (patch.paymentLinkUrl !== undefined) set.payment_link_url = patch.paymentLinkUrl;
    if (patch.failureReason !== undefined) set.failure_reason = patch.failureReason;
    if (patch.rawResponse !== undefined) set.raw_response = patch.rawResponse;
    if (patch.settledAt !== undefined) set.settled_at = patch.settledAt.toISOString();
    if (patch.failedAt !== undefined) set.failed_at = patch.failedAt.toISOString();
    if (patch.lastVerifiedAt !== undefined)
      set.last_verified_at = patch.lastVerifiedAt.toISOString();
    if (patch.verifyPollCount !== undefined) set.verify_poll_count = patch.verifyPollCount;

    const [row] = await this.db.update(pa).set(set).where(eq(pa.id, id)).returning();
    if (!row) throw new PaymentAttemptNotFoundError(id);
    return row;
  }

  async findById(id: string): Promise<PaymentAttempt | undefined> {
    return (await this.db.select().from(pa).where(eq(pa.id, id)).limit(1))[0];
  }

  async findByProviderReference(reference: string): Promise<PaymentAttempt | undefined> {
    return (
      await this.db.select().from(pa).where(eq(pa.provider_reference, reference)).limit(1)
    )[0];
  }

  async findByIdempotencyKey(key: string): Promise<PaymentAttempt | undefined> {
    return (await this.db.select().from(pa).where(eq(pa.idempotency_key, key)).limit(1))[0];
  }

  /** The newest attempt on a schedule, whatever became of it. */
  async findLatestForSchedule(
    scheduleId: string,
    opts: { channel?: PaymentChannel } = {},
  ): Promise<PaymentAttempt | undefined> {
    return (
      await this.db
        .select()
        .from(pa)
        .where(
          opts.channel
            ? and(eq(pa.schedule_id, scheduleId), eq(pa.channel, opts.channel))
            : eq(pa.schedule_id, scheduleId),
        )
        .orderBy(desc(pa.initiated_at))
        .limit(1)
    )[0];
  }

  /**
   * The newest unresolved attempt for a schedule, if any. `in_flight` means a
   * charge is live at the provider; `unknown` means we could not determine
   * whether money moved. Either way a fresh charge risks debiting the customer
   * twice, so callers must refuse rather than initiate one.
   */
  async findUnresolvedForSchedule(scheduleId: string): Promise<PaymentAttempt | undefined> {
    return (
      await this.db
        .select()
        .from(pa)
        .where(and(eq(pa.schedule_id, scheduleId), inArray(pa.status, ['in_flight', 'unknown'])))
        .orderBy(desc(pa.initiated_at))
        .limit(1)
    )[0];
  }

  /**
   * Unresolved attempts that started before `staleBefore` and haven't been
   * verified since — the lost-webhook backlog the verify-poll worker drains.
   * Oldest first so the longest-stuck attempts resolve first.
   *
   * Covers `unknown` as well as `in_flight`. `unknown` is what a network fault
   * or provider 5xx leaves behind — "we don't know whether money moved" — and
   * it is precisely the state that most needs resolving. This query previously
   * filtered `in_flight` alone, so every `unknown` attempt was stranded
   * permanently and its installment sat in `processing` forever, invisible to
   * the debit sweep, the retry queue and collections alike. The partial index
   * `payment_attempts_in_flight_idx` was already built over both statuses.
   */
  async findStaleUnresolved(staleBefore: Date, limit = 200): Promise<PaymentAttempt[]> {
    const cutoff = staleBefore.toISOString();
    return this.db
      .select()
      .from(pa)
      .where(
        and(
          inArray(pa.status, ['in_flight', 'unknown']),
          lt(pa.initiated_at, cutoff),
          or(isNull(pa.last_verified_at), lt(pa.last_verified_at, cutoff)),
        ),
      )
      .orderBy(asc(pa.initiated_at))
      .limit(limit);
  }

  /** @deprecated Use {@link findStaleUnresolved} — this misses `unknown` attempts. */
  async findStaleInFlight(staleBefore: Date, limit = 200): Promise<PaymentAttempt[]> {
    return this.findStaleUnresolved(staleBefore, limit);
  }
}
