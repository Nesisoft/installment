import { sql } from 'drizzle-orm';
import type { Database } from '@installment/db';

/** Status of a seller nothing will be paid to again, so nothing nets off. */
const UNPAYABLE_STATUSES = ['suspended', 'offboarded'] as const;

/** A seller is "new" for this long — the window a payout hold would cover. */
export const NEW_SELLER_DAYS = 30;

export interface SellerOwingRow {
  merchant_id: string;
  business_name: string;
  status: string;
  /** What the seller owes Ejua: their `merchant_payable` balance, negated. */
  owed_pesewas: number;
  /**
   * True when the seller can no longer be paid out — suspended or offboarded —
   * so the balance will not net off future sales. Money Ejua has to recover
   * directly, or write off.
   */
  unrecoverable: boolean;
  /** Days since activation (or signup, before activation). */
  seller_age_days: number;
  /** What returns took off their payable in the last 90 days. */
  returns_90d_pesewas: number;
  returns_90d_count: number;
  last_payout_at: string | null;
  last_payout_pesewas: number | null;
}

export interface SellersOwingSummary {
  sellers: number;
  owed_pesewas: number;
  unrecoverable_sellers: number;
  unrecoverable_pesewas: number;
  /** Of the owing sellers, how many are inside their first {@link NEW_SELLER_DAYS} days. */
  new_sellers: number;
}

/**
 * Sellers who owe Ejua money: a negative `merchant_payable`.
 *
 * Settlement pays a seller what they are owed every day, and a return, an
 * instalment refund or a hybrid default then takes its share back off the same
 * balance. When what is taken back exceeds what is left, the balance goes
 * negative and future payouts net it off — unless there are no future payouts,
 * because the seller was paid and left. That is the risk escrow would cover, at
 * the cost of holding every seller's money for a week or two after delivery.
 * The call was not to hold everyone's money, and to watch for this instead;
 * this is the watching. Holding payouts for new sellers only is the next step
 * if it becomes material, which is why each row carries the seller's age.
 */
export class SellersOwingReport {
  constructor(private readonly db: Database) {}

  async list(now: Date = new Date()): Promise<SellerOwingRow[]> {
    const since90d = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const result = await this.db.execute(sql`
      WITH balances AS (
        SELECT account_ref AS merchant_ref,
               sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) AS balance
        FROM ledger_entries
        WHERE account_type = 'merchant_payable'
        GROUP BY account_ref
        HAVING sum(CASE direction WHEN 'credit' THEN amount_pesewas ELSE -amount_pesewas END) < 0
      ),
      returns AS (
        SELECT account_ref AS merchant_ref,
               coalesce(sum(amount_pesewas), 0) AS amount,
               count(DISTINCT transaction_id) AS n
        FROM ledger_entries
        WHERE account_type = 'merchant_payable'
          AND direction = 'debit'
          AND transaction_id LIKE 'order-return:%'
          AND occurred_at >= ${since90d}
        GROUP BY account_ref
      ),
      last_payout AS (
        SELECT DISTINCT ON (merchant_id) merchant_id, settled_at, amount_pesewas
        FROM payouts
        WHERE status = 'settled'
        ORDER BY merchant_id, settled_at DESC
      )
      SELECT m.id AS merchant_id,
             m.business_name,
             m.status,
             -b.balance AS owed,
             coalesce(m.onboarded_at, m.created_at) AS since,
             coalesce(r.amount, 0) AS returns_amount,
             coalesce(r.n, 0) AS returns_count,
             lp.settled_at AS last_payout_at,
             lp.amount_pesewas AS last_payout_amount
      FROM balances b
      JOIN merchants m ON m.id::text = b.merchant_ref
      LEFT JOIN returns r ON r.merchant_ref = b.merchant_ref
      LEFT JOIN last_payout lp ON lp.merchant_id = m.id
    `);

    const rows = (result.rows as Record<string, unknown>[]).map<SellerOwingRow>((r) => {
      const status = String(r.status);
      const since = new Date(String(r.since));
      return {
        merchant_id: String(r.merchant_id),
        business_name: String(r.business_name),
        status,
        owed_pesewas: Number(r.owed),
        unrecoverable: (UNPAYABLE_STATUSES as readonly string[]).includes(status),
        seller_age_days: Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000)),
        returns_90d_pesewas: Number(r.returns_amount),
        returns_90d_count: Number(r.returns_count),
        last_payout_at: r.last_payout_at ? new Date(String(r.last_payout_at)).toISOString() : null,
        last_payout_pesewas: r.last_payout_amount === null ? null : Number(r.last_payout_amount),
      };
    });
    // The money Ejua cannot net off comes first; then the largest debts.
    return rows.sort(
      (a, b) =>
        Number(b.unrecoverable) - Number(a.unrecoverable) || b.owed_pesewas - a.owed_pesewas,
    );
  }

  summarise(rows: readonly SellerOwingRow[]): SellersOwingSummary {
    const unrecoverable = rows.filter((r) => r.unrecoverable);
    return {
      sellers: rows.length,
      owed_pesewas: rows.reduce((s, r) => s + r.owed_pesewas, 0),
      unrecoverable_sellers: unrecoverable.length,
      unrecoverable_pesewas: unrecoverable.reduce((s, r) => s + r.owed_pesewas, 0),
      new_sellers: rows.filter((r) => r.seller_age_days < NEW_SELLER_DAYS).length,
    };
  }
}
