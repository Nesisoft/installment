import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@installment/db';
import { LedgerError, LedgerService, type LedgerEntryInput } from './ledger.service';

function balanced(txn = 'txn-1'): LedgerEntryInput[] {
  return [
    {
      transactionId: txn,
      accountType: 'receivable',
      accountRef: 'plan-1',
      direction: 'debit',
      amountPesewas: 100_000,
      description: 'Receivable',
    },
    {
      transactionId: txn,
      accountType: 'merchant_payable',
      accountRef: 'merchant-1',
      direction: 'credit',
      amountPesewas: 91_000,
      description: 'Net payout',
    },
    {
      transactionId: txn,
      accountType: 'reserve_held',
      accountRef: 'merchant-1',
      direction: 'credit',
      amountPesewas: 5_000,
      description: 'Reserve',
    },
    {
      transactionId: txn,
      accountType: 'revenue',
      accountRef: 'platform',
      direction: 'credit',
      amountPesewas: 4_000,
      description: 'MDR',
    },
  ];
}

function makeDb() {
  const values = vi.fn((_rows: Array<Record<string, unknown>>) => Promise.resolve(undefined));
  const insert = vi.fn((_table: unknown) => ({ values }));
  const txExec = { insert };
  const transaction = vi.fn((cb: (t: typeof txExec) => unknown) => Promise.resolve(cb(txExec)));
  const db = { insert, transaction } as unknown as Database;
  return { db, insert, values, transaction };
}

describe('LedgerService.record — invariants', () => {
  it('rejects an unbalanced transaction', async () => {
    const { db } = makeDb();
    const svc = new LedgerService(db);
    const entries = balanced();
    entries[1]!.amountPesewas = 90_000; // debits 100000 != credits 99000

    await expect(svc.record(entries)).rejects.toThrow(
      /Unbalanced transaction: debits=100000 credits=99000/,
    );
    await expect(svc.record(entries)).rejects.toBeInstanceOf(LedgerError);
  });

  it('rejects an empty entry list', async () => {
    const { db } = makeDb();
    await expect(new LedgerService(db).record([])).rejects.toThrow(/no entries/);
  });

  it('rejects mixed transactionIds in one call', async () => {
    const { db } = makeDb();
    const entries = balanced();
    entries[2]!.transactionId = 'other';
    await expect(new LedgerService(db).record(entries)).rejects.toThrow(/Mixed transactionIds/);
  });

  it('rejects non-positive, non-integer and unsafe amounts', async () => {
    const { db } = makeDb();
    const svc = new LedgerService(db);

    const zero = balanced();
    zero[0]!.amountPesewas = 0;
    await expect(svc.record(zero)).rejects.toThrow(/> 0/);

    const frac = balanced();
    frac[0]!.amountPesewas = 100.5;
    await expect(svc.record(frac)).rejects.toThrow(/safe integer/);

    const unsafe = balanced();
    unsafe[0]!.amountPesewas = Number.MAX_SAFE_INTEGER + 1;
    await expect(svc.record(unsafe)).rejects.toThrow(/safe integer/);
  });

  it('rejects invalid account type and direction', async () => {
    const { db } = makeDb();
    const svc = new LedgerService(db);

    const badType = balanced();
    (badType[0] as { accountType: string }).accountType = 'slush_fund';
    await expect(svc.record(badType)).rejects.toThrow(/Invalid account_type/);

    const badDir = balanced();
    (badDir[0] as { direction: string }).direction = 'sideways';
    await expect(svc.record(badDir)).rejects.toThrow(/Invalid direction/);
  });

  it('does not touch the database when validation fails', async () => {
    const { db, insert, transaction } = makeDb();
    const entries = balanced();
    entries[0]!.amountPesewas = 1; // unbalanced
    await expect(new LedgerService(db).record(entries)).rejects.toThrow(LedgerError);
    expect(insert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('LedgerService.record — persistence', () => {
  it('opens its own transaction and inserts mapped rows when no tx is given', async () => {
    const { db, insert, values, transaction } = makeDb();
    const txn = await new LedgerService(db).record(balanced('accrue:plan-1'));

    expect(txn).toBe('accrue:plan-1');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    const rows = values.mock.calls[0]![0];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      transaction_id: 'accrue:plan-1',
      account_type: 'receivable',
      account_ref: 'plan-1',
      direction: 'debit',
      amount_pesewas: 100_000,
      currency: 'GHS',
      metadata: {},
    });
  });

  it('joins a caller-supplied executor without opening a new transaction', async () => {
    const { db, transaction } = makeDb();
    const callerValues = vi.fn(async () => undefined);
    const callerInsert = vi.fn(() => ({ values: callerValues }));
    const callerTx = { insert: callerInsert } as never;

    await new LedgerService(db).record(balanced(), callerTx);

    expect(callerInsert).toHaveBeenCalledTimes(1);
    expect(callerValues).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('LedgerService.balanceOf', () => {
  it('returns sum(credits) − sum(debits) as a number', async () => {
    const where = vi.fn(async () => [{ balance: '4000' }]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Database;

    const balance = await new LedgerService(db).balanceOf('revenue', 'platform');
    expect(balance).toBe(4000);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('coerces a null/absent aggregate to 0', async () => {
    const where = vi.fn(async () => [] as Array<{ balance: string }>);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Database;

    expect(await new LedgerService(db).balanceOf('reserve_held', 'merchant-x')).toBe(0);
  });
});
