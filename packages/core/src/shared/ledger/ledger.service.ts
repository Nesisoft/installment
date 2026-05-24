import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';

const ledger = schema.ledger_entries;

/** The seven account types enforced by the ledger_entries CHECK constraint. */
export const LEDGER_ACCOUNT_TYPES = [
  'paystack_settlement',
  'merchant_payable',
  'reserve_held',
  'default_pool',
  'revenue',
  'receivable',
  'refund_payable',
] as const;

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];
export type LedgerDirection = 'debit' | 'credit';

export interface LedgerEntryInput {
  /** Groups the debit(s) and credit(s) of one balanced transaction. */
  transactionId: string;
  accountType: LedgerAccountType;
  /** merchant_id, customer_plan_id, 'platform', 'main', etc. */
  accountRef: string;
  direction: LedgerDirection;
  /** Always a positive integer number of pesewas (DB CHECK: amount_pesewas > 0). */
  amountPesewas: number;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * A query executor — either the root Drizzle client or an open transaction.
 * Passing a caller's transaction makes the ledger write atomic with the
 * caller's state change + audit row (Guiding principle #3 & #4).
 */
export type LedgerExecutor = Pick<Database, 'insert' | 'select'>;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set(LEDGER_ACCOUNT_TYPES);

/**
 * Double-entry ledger — the only source of financial truth.
 *
 * `record()` rejects any transaction where the sum of debits does not equal
 * the sum of credits. Ported from docs/design/settlement-engine.ts. The
 * `ledger_entries` table is append-only (enforced by a DB trigger); this
 * service is the only writer.
 */
export class LedgerService {
  constructor(private readonly db: Database) {}

  /**
   * Records one balanced transaction. All entries must share a single
   * `transactionId`. Throws {@link LedgerError} if unbalanced or invalid —
   * the single most important invariant in the system.
   *
   * @param tx optional executor to join the caller's transaction; when
   *           omitted the inserts run in their own transaction.
   * @returns the transactionId that was recorded.
   */
  async record(entries: LedgerEntryInput[], tx?: LedgerExecutor): Promise<string> {
    const transactionId = this.validate(entries);

    const rows = entries.map((e) => ({
      transaction_id: e.transactionId,
      account_type: e.accountType,
      account_ref: e.accountRef,
      direction: e.direction,
      amount_pesewas: e.amountPesewas,
      currency: 'GHS' as const,
      description: e.description,
      metadata: e.metadata ?? {},
    }));

    if (tx) {
      await tx.insert(ledger).values(rows);
    } else {
      await this.db.transaction(async (t) => {
        await t.insert(ledger).values(rows);
      });
    }

    return transactionId;
  }

  /**
   * Net balance for an account: sum(credits) − sum(debits), in pesewas.
   * Positive means a liability/income balance (we owe / we earned).
   */
  async balanceOf(
    accountType: LedgerAccountType,
    accountRef: string,
    tx?: LedgerExecutor,
  ): Promise<number> {
    const exec = tx ?? this.db;
    const rows = await exec
      .select({
        balance: sql<string>`coalesce(sum(${ledger.amount_pesewas} * case ${ledger.direction} when 'credit' then 1 else -1 end), 0)`,
      })
      .from(ledger)
      .where(and(eq(ledger.account_type, accountType), eq(ledger.account_ref, accountRef)));

    const raw = rows[0]?.balance ?? '0';
    return Number(raw);
  }

  /** Pure validation. Returns the shared transactionId. Throws on any problem. */
  private validate(entries: LedgerEntryInput[]): string {
    if (entries.length === 0) {
      throw new LedgerError('Ledger transaction has no entries');
    }

    const transactionId = entries[0]!.transactionId;
    let debits = 0;
    let credits = 0;

    for (const e of entries) {
      if (e.transactionId !== transactionId) {
        throw new LedgerError(
          `Mixed transactionIds in one record() call: "${transactionId}" vs "${e.transactionId}"`,
        );
      }
      if (!transactionId) {
        throw new LedgerError('Ledger entry is missing a transactionId');
      }
      if (!ACCOUNT_TYPE_SET.has(e.accountType)) {
        throw new LedgerError(`Invalid account_type "${e.accountType}"`);
      }
      if (!e.accountRef) {
        throw new LedgerError('Ledger entry is missing an accountRef');
      }
      if (e.direction !== 'debit' && e.direction !== 'credit') {
        throw new LedgerError(`Invalid direction "${e.direction}"`);
      }
      if (!Number.isInteger(e.amountPesewas) || !Number.isSafeInteger(e.amountPesewas)) {
        throw new LedgerError(`amountPesewas must be a safe integer, got ${e.amountPesewas}`);
      }
      if (e.amountPesewas <= 0) {
        throw new LedgerError(`amountPesewas must be > 0, got ${e.amountPesewas}`);
      }
      if (!e.description) {
        throw new LedgerError('Ledger entry is missing a description');
      }
      if (e.direction === 'debit') debits += e.amountPesewas;
      else credits += e.amountPesewas;
    }

    if (debits !== credits) {
      throw new LedgerError(`Unbalanced transaction: debits=${debits} credits=${credits}`);
    }

    return transactionId;
  }
}
