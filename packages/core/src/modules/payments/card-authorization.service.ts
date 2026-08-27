import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';

const ca = schema.customer_card_authorizations;

export type CardAuthorization = typeof ca.$inferSelect;

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
          // A card that was revoked and is presented again working is active
          // again — the customer has evidently fixed whatever was wrong.
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
  async findUsable(customerId: string, now: Date = new Date()): Promise<CardAuthorization | null> {
    const rows = await this.db
      .select()
      .from(ca)
      .where(and(eq(ca.customer_id, customerId), eq(ca.status, 'active'), eq(ca.reusable, true)))
      .orderBy(desc(ca.created_at));

    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const usable = rows.find((row) => {
      // Unknown expiry is not treated as expired: the provider is the authority
      // and will refuse it, whereas discarding it here loses a working card.
      if (row.exp_year === null || row.exp_month === null) return true;
      return row.exp_year > year || (row.exp_year === year && row.exp_month >= month);
    });
    return usable ?? null;
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
