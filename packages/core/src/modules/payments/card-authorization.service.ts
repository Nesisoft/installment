import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';

const ca = schema.customer_card_authorizations;

export type CardAuthorization = typeof ca.$inferSelect;

/**
 * A saved card as the customer sees it.
 *
 * Deliberately not the row: `authorization_code` is the credential — anything
 * holding it can charge the card — so it never leaves this service. last4 and
 * brand are here so a person can recognise their own card, and nothing more.
 */
/** A saved card that still has a credential, so it can actually be charged. */
export type ChargeableCard = CardAuthorization & { authorization_code: string };

export interface SavedCardView {
  id: string;
  last4: string | null;
  brand: string | null;
  bank: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string;
  is_usable: boolean;
  last_used_at: string | null;
  created_at: string;
}

/** The saved-card handle a provider returns with a successful card charge. */
export interface ProviderAuthorization {
  authorization_code: string;
  signature?: string;
  last4?: string;
  brand?: string;
  card_type?: string;
  bank?: string;
  exp_month?: string;
  exp_year?: string;
  reusable?: boolean;
}

function toSmallInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Saved card authorizations, and the rule for whether one can still be charged.
 *
 * `PaymentService.chargeCard` could always debit a card without the cardholder
 * present — that is what a Paystack authorization code is for — but nothing
 * ever kept one, so the capability was unreachable and every instalment fell
 * back to a Mobile Money prompt the customer had to answer.
 *
 * What is stored is the authorization code plus enough to tell one card from
 * another. Never a PAN and never a CVV: the code IS the credential, and last4
 * and brand exist so a person can recognise their own card in a list.
 */
export class CardAuthorizationService {
  constructor(private readonly db: Database) {}

  /**
   * Records an authorization from a successful charge.
   *
   * Refuses anything the provider did not mark reusable. A single-use
   * authorization looks identical in the response and fails on the next debit,
   * so storing one would mean discovering it one missed instalment at a time.
   *
   * Re-saving the same card updates the row rather than adding another, so the
   * collector never has to choose between duplicates of one card.
   */
  async record(customerId: string, auth: ProviderAuthorization): Promise<CardAuthorization | null> {
    if (!auth?.authorization_code || !auth.reusable) return null;

    const values = {
      customer_id: customerId,
      authorization_code: auth.authorization_code,
      signature: auth.signature ?? null,
      last4: auth.last4 ?? null,
      brand: auth.brand ?? null,
      card_type: auth.card_type ?? null,
      bank: auth.bank ?? null,
      exp_month: toSmallInt(auth.exp_month),
      exp_year: toSmallInt(auth.exp_year),
      reusable: true,
      status: 'active' as const,
    };

    const [row] = await this.db
      .insert(ca)
      .values(values)
      .onConflictDoUpdate({
        target: ca.authorization_code,
        set: {
          ...values,
          // A card the PROVIDER revoked comes back when it is presented working
          // again — the customer evidently fixed whatever was wrong. A card the
          // CUSTOMER removed must not: reactivating that would put a credential
          // they deleted back on file behind their back. Removal also nulls the
          // code, so in practice a re-save creates a new row and never reaches
          // this branch; the guard is here so that stays true if it ever does.
          status: sql`case when ${ca.status} = 'removed' then 'removed' else 'active' end`,
          revoked_at: null,
          revoked_reason: null,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return row ?? null;
  }

  /**
   * The card to charge for this customer, or null if there isn't a usable one.
   *
   * Expiry is checked here rather than left to the provider: charging a card
   * everyone can see has expired wastes an attempt, and on a schedule that
   * counts attempts it pushes a customer toward default for no reason.
   */
  async findUsable(customerId: string, now: Date = new Date()): Promise<ChargeableCard | null> {
    const rows = await this.db
      .select()
      .from(ca)
      .where(
        and(
          eq(ca.customer_id, customerId),
          eq(ca.status, 'active'),
          eq(ca.reusable, true),
          // A removed card has had its code dropped. Filtered in SQL as well as
          // by status so a chargeable card can never be one without a
          // credential — the collector must not be able to reach a null.
          isNotNull(ca.authorization_code),
        ),
      )
      .orderBy(desc(ca.created_at));

    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const usable = (rows as ChargeableCard[]).find((row) => {
      // Unknown expiry is not treated as expired: the provider is the authority
      // and will refuse it, whereas discarding it here loses a working card.
      if (row.exp_year === null || row.exp_month === null) return true;
      return row.exp_year > year || (row.exp_year === year && row.exp_month >= month);
    });
    return usable ?? null;
  }

  /** The customer's saved cards, as they are allowed to see them. */
  async listViewForCustomer(customerId: string, now: Date = new Date()): Promise<SavedCardView[]> {
    const rows = await this.listForCustomer(customerId);
    const usable = await this.findUsable(customerId, now);
    return rows
      .filter((row) => row.status !== 'removed')
      .map((row) => ({
        id: row.id,
        last4: row.last4,
        brand: row.brand,
        bank: row.bank,
        exp_month: row.exp_month,
        exp_year: row.exp_year,
        status: row.status,
        is_usable: usable?.id === row.id,
        last_used_at: row.last_used_at,
        created_at: row.created_at,
      }));
  }

  /**
   * Takes a card off file at the customer's request.
   *
   * Scoped to the owner, and answers "not found" for someone else's card rather
   * than confirming it exists. Drops the authorization code: the row survives so
   * a person can see what they removed and when, but the part that can charge
   * them does not.
   */
  async removeForCustomer(
    customerId: string,
    cardId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const [row] = await this.db
      .update(ca)
      .set({
        status: 'removed',
        authorization_code: null,
        revoked_at: now.toISOString(),
        revoked_reason: 'removed_by_customer',
        updated_at: sql`now()`,
      })
      .where(and(eq(ca.id, cardId), eq(ca.customer_id, customerId)))
      .returning({ id: ca.id });
    return Boolean(row);
  }

  /** Marks a charge as used, so the most recently working card is visible. */
  async markUsed(authorizationCode: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(ca)
      .set({ last_used_at: now.toISOString(), updated_at: sql`now()` })
      .where(eq(ca.authorization_code, authorizationCode));
  }

  /**
   * Retires an authorization the provider has told us can never work again.
   * Without this the collector keeps spending attempts on a dead card.
   */
  async revoke(authorizationCode: string, reason: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(ca)
      .set({
        status: 'revoked',
        revoked_at: now.toISOString(),
        revoked_reason: reason.slice(0, 300),
        updated_at: sql`now()`,
      })
      .where(eq(ca.authorization_code, authorizationCode));
  }

  /** The customer's saved cards, for showing them what is on file. */
  async listForCustomer(customerId: string): Promise<CardAuthorization[]> {
    return this.db
      .select()
      .from(ca)
      .where(eq(ca.customer_id, customerId))
      .orderBy(desc(ca.created_at));
  }
}
