import { sql } from 'drizzle-orm';
import type { Database } from '@installment/db';
import type { LedgerAccountType } from './ledger.service';

/** One account type's net position. `balance = credits - debits`. */
export interface TrialBalanceRow {
  accountType: LedgerAccountType;
  debitsPesewas: number;
  creditsPesewas: number;
  balancePesewas: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  /**
   * Sum of every account balance. Must be exactly 0: every transaction posts
   * equal debits and credits, so the whole book nets out. A non-zero total is
   * proof the ledger has drifted.
   */
  totalPesewas: number;
  balanced: boolean;
}

/** A transaction whose debits and credits disagree — should never exist. */
export interface UnbalancedTransaction {
  transactionId: string;
  debitsPesewas: number;
  creditsPesewas: number;
  driftPesewas: number;
}

export interface IntegrityReport {
  checkedAt: string;
  trialBalance: TrialBalance;
  unbalancedTransactions: UnbalancedTransaction[];
  healthy: boolean;
}

/**
 * Reads the ledger and answers "are the books still internally consistent?".
 *
 * `LedgerService.record` validates each transaction as it is written, but that
 * is a per-call check inside application code. It cannot see a transaction
 * written by an older code path, a hand-run SQL fix, a partially-applied
 * migration, or a bug in a future write site. Nothing in the database enforces
 * the invariant globally, and `ledger_entries` is append-only — so drift can
 * never be edited away, only compensated. Detecting it early is the difference
 * between one compensating entry and a reconciliation project.
 *
 * Read-only by construction: this service never writes.
 */
export class LedgerIntegrityService {
  constructor(private readonly db: Database) {}

  /**
   * Net position per account type, plus the global total.
   *
   * The total is the headline number. Individual account balances are expected
   * to be non-zero (the platform holds cash, owes merchants, has earned
   * revenue); it is their *sum* that must be zero.
   */
  async trialBalance(): Promise<TrialBalance> {
    const result = await this.db.execute(sql`
      SELECT account_type,
             sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END) AS debits,
             sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END) AS credits
      FROM ledger_entries
      GROUP BY account_type
      ORDER BY account_type
    `);

    const rows: TrialBalanceRow[] = (
      result.rows as Array<{ account_type: string; debits: string; credits: string }>
    ).map((r) => {
      const debits = Number(r.debits);
      const credits = Number(r.credits);
      return {
        accountType: r.account_type as LedgerAccountType,
        debitsPesewas: debits,
        creditsPesewas: credits,
        balancePesewas: credits - debits,
      };
    });

    const totalPesewas = rows.reduce((sum, r) => sum + r.balancePesewas, 0);
    return { rows, totalPesewas, balanced: totalPesewas === 0 };
  }

  /**
   * Every transaction whose debits do not equal its credits.
   *
   * This is the precise locator: the trial balance says *whether* the book has
   * drifted, this says *where*. Bounded so a badly broken ledger cannot return
   * an unbounded result set to an alert or an HTTP response.
   */
  async findUnbalancedTransactions(limit = 100): Promise<UnbalancedTransaction[]> {
    const result = await this.db.execute(sql`
      SELECT transaction_id,
             sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END) AS debits,
             sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END) AS credits
      FROM ledger_entries
      GROUP BY transaction_id
      HAVING sum(CASE WHEN direction = 'debit'  THEN amount_pesewas ELSE 0 END)
          <> sum(CASE WHEN direction = 'credit' THEN amount_pesewas ELSE 0 END)
      ORDER BY transaction_id
      LIMIT ${limit}
    `);

    return (result.rows as Array<{ transaction_id: string; debits: string; credits: string }>).map(
      (r) => {
        const debits = Number(r.debits);
        const credits = Number(r.credits);
        return {
          transactionId: r.transaction_id,
          debitsPesewas: debits,
          creditsPesewas: credits,
          driftPesewas: credits - debits,
        };
      },
    );
  }

  /** Both checks together — what the cron and the admin endpoint report. */
  async report(now: Date = new Date()): Promise<IntegrityReport> {
    const [trialBalance, unbalancedTransactions] = await Promise.all([
      this.trialBalance(),
      this.findUnbalancedTransactions(),
    ]);
    return {
      checkedAt: now.toISOString(),
      trialBalance,
      unbalancedTransactions,
      healthy: trialBalance.balanced && unbalancedTransactions.length === 0,
    };
  }
}
