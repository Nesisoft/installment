import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { MerchantsService } from './merchants.service';
import { MerchantNotFoundError, PayoutAccountUnresolvedError, UnknownBankError } from './errors';
import { PayoutAccountService, type PayoutRecipientClient } from './payout-account.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/** Paystack's Ghana list, trimmed to the two shapes that behave differently. */
const BANKS = [
  { name: 'MTN Mobile Money', code: 'MTN', type: 'mobile_money', currency: 'GHS' },
  { name: 'Absa Bank Ghana', code: '030100', type: 'ghipss', currency: 'GHS' },
  { name: 'A Nigerian bank', code: '044', type: 'nuban', currency: 'NGN' },
  { name: 'A closed bank', code: '999', type: 'ghipss', currency: 'GHS', active: false },
];

interface StubOptions {
  accountName?: string;
  resolveThrows?: Error;
  recipientCode?: string | null;
}

function stubPaystack(opts: StubOptions = {}) {
  const calls = {
    banks: 0,
    resolve: [] as { accountNumber: string; bankCode: string }[],
    recipients: [] as Parameters<PayoutRecipientClient['createTransferRecipient']>[0][],
  };
  const client: PayoutRecipientClient = {
    listBanks: async () => {
      calls.banks += 1;
      return { data: BANKS };
    },
    resolveAccount: async (accountNumber, bankCode) => {
      calls.resolve.push({ accountNumber, bankCode });
      if (opts.resolveThrows) throw opts.resolveThrows;
      return {
        data: { account_number: accountNumber, account_name: opts.accountName ?? 'AKUA BOATENG' },
      };
    },
    createTransferRecipient: async (req) => {
      calls.recipients.push(req);
      const code = opts.recipientCode === undefined ? 'RCP_stub123' : opts.recipientCode;
      return { data: { recipient_code: code as string } };
    },
  };
  return { client, calls };
}

describe.skipIf(!RUN_DB)('PayoutAccountService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const merchants = new MerchantsService(db, audit);
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function newMerchant() {
    const suffix = randomUUID();
    return merchants.create(
      {
        business_name: `Ejua Mart ${suffix}`,
        legal_name: `Ejua Ghana Limited ${suffix}`,
        email: `ops+${suffix}@ejua.gh`,
        phone: '+233244123456',
      },
      SYSTEM_ACTOR,
    );
  }

  async function lastAuditRow(merchantId: string) {
    const rows = await db
      .select({
        event_type: schema.audit_events.event_type,
        from_state: schema.audit_events.from_state,
        to_state: schema.audit_events.to_state,
        metadata: schema.audit_events.metadata,
      })
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, merchantId),
          eq(schema.audit_events.entity_type, 'merchant'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0];
  }

  // ------------------------------------------------------------ destinations

  it('offers only Ghanaian destinations Paystack can actually pay, sorted by name', async () => {
    const { client } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    const destinations = await svc.listDestinations();

    // The Nigerian NUBAN entry and the inactive bank are both unpayable here;
    // offering either produces a picker whose choices fail at the last step.
    expect(destinations.map((d) => d.code)).toEqual(['030100', 'MTN']);
    expect(destinations.find((d) => d.code === 'MTN')?.kind).toBe('mobile_money');
    expect(destinations.find((d) => d.code === '030100')?.kind).toBe('bank');
  });

  it('caches the destination list rather than refetching it per page view', async () => {
    const { client, calls } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    await svc.listDestinations();
    await svc.listDestinations();

    expect(calls.banks).toBe(1);
  });

  // ----------------------------------------------------------------- resolve

  it('returns the name the bank holds, and writes nothing', async () => {
    const merchant = await newMerchant();
    const { client } = stubPaystack({ accountName: 'AKUA BOATENG' });
    const svc = new PayoutAccountService(db, audit, client);

    const resolved = await svc.resolve(merchant.id, {
      bank_code: 'MTN',
      account_number: '024 477-1122',
    });

    expect(resolved.account_name).toBe('AKUA BOATENG');
    // Spaces and dashes are how people write account numbers; the digits are
    // what reaches the bank.
    expect(resolved.account_number).toBe('0244771122');

    const reread = await merchants.get(merchant.id);
    expect(reread.paystack_recipient_code).toBeNull();
    expect(reread.bank_account_number).toBeNull();
  });

  it('refuses a bank that is not on the payable list', async () => {
    const merchant = await newMerchant();
    const { client } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    await expect(
      svc.resolve(merchant.id, { bank_code: '044', account_number: '1234567890' }),
    ).rejects.toBeInstanceOf(UnknownBankError);
  });

  // --------------------------------------------------------------------- set

  it('stores the recipient code, the bank details and the bank-held name', async () => {
    const merchant = await newMerchant();
    const { client, calls } = stubPaystack({ accountName: 'EJUA GHANA LIMITED' });
    const svc = new PayoutAccountService(db, audit, client);

    const updated = await svc.set(
      merchant.id,
      { bank_code: '030100', account_number: '1234567890123' },
      SYSTEM_ACTOR,
    );

    expect(updated.paystack_recipient_code).toBe('RCP_stub123');
    expect(updated.bank_code).toBe('030100');
    expect(updated.bank_account_number).toBe('1234567890123');
    expect(updated.bank_account_name).toBe('EJUA GHANA LIMITED');

    // A GhIPSS account and a MoMo wallet are different recipient types, and
    // Paystack rejects the wrong one.
    expect(calls.recipients[0]?.type).toBe('ghipss');
    expect(calls.recipients[0]?.currency).toBe('GHS');
  });

  it('creates a mobile-money recipient for a wallet', async () => {
    const merchant = await newMerchant();
    const { client, calls } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    await svc.set(merchant.id, { bank_code: 'MTN', account_number: '0244771122' }, SYSTEM_ACTOR);

    expect(calls.recipients[0]?.type).toBe('mobile_money');
  });

  it('sends the bank-held name to Paystack, never a caller-supplied one', async () => {
    const merchant = await newMerchant();
    const { client, calls } = stubPaystack({ accountName: 'AKUA BOATENG' });
    const svc = new PayoutAccountService(db, audit, client);

    // A name in the body is ignored: accepting one would let an account be
    // registered under a name of the sender's choosing.
    await svc.set(
      merchant.id,
      { bank_code: 'MTN', account_number: '0244771122', account_name: 'SOMEBODY ELSE' },
      SYSTEM_ACTOR,
    );

    expect(calls.recipients[0]?.name).toBe('AKUA BOATENG');
  });

  it('refuses when the bank will not confirm the account, and leaves the old one in place', async () => {
    const merchant = await newMerchant();
    const good = stubPaystack({ accountName: 'AKUA BOATENG' });
    const svc = new PayoutAccountService(db, audit, good.client);
    await svc.set(merchant.id, { bank_code: 'MTN', account_number: '0244771122' }, SYSTEM_ACTOR);

    const bad = stubPaystack({ resolveThrows: new Error('Could not resolve account name') });
    const failing = new PayoutAccountService(db, audit, bad.client);
    await expect(
      failing.set(merchant.id, { bank_code: '030100', account_number: '9999999999' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(PayoutAccountUnresolvedError);

    // The previous destination still stands — a failed change must not strand
    // a merchant with no way to be paid.
    const reread = await merchants.get(merchant.id);
    expect(reread.paystack_recipient_code).toBe('RCP_stub123');
    expect(reread.bank_code).toBe('MTN');
    expect(bad.calls.recipients).toHaveLength(0);
  });

  it('refuses when the provider returns no recipient code', async () => {
    const merchant = await newMerchant();
    const { client } = stubPaystack({ recipientCode: null });
    const svc = new PayoutAccountService(db, audit, client);

    await expect(
      svc.set(merchant.id, { bank_code: 'MTN', account_number: '0244771122' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(PayoutAccountUnresolvedError);
  });

  it('audits the change with both ends masked', async () => {
    const merchant = await newMerchant();
    const { client } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    await svc.set(merchant.id, { bank_code: 'MTN', account_number: '0244771122' }, SYSTEM_ACTOR);
    const first = await lastAuditRow(merchant.id);
    expect(first?.event_type).toBe('merchant.payout_account_set');
    expect(first?.from_state).toBe('none');
    expect(first?.to_state).toBe('MTN:••••1122');

    await svc.set(
      merchant.id,
      { bank_code: '030100', account_number: '1234567890123' },
      SYSTEM_ACTOR,
    );
    const second = await lastAuditRow(merchant.id);
    expect(second?.from_state).toBe('MTN:••••1122');
    expect(second?.to_state).toBe('030100:••••0123');
    // Where the money went is reconstructible; the full number is not in a log
    // more people read than a payout needs.
    expect(JSON.stringify(second?.metadata)).not.toContain('1234567890123');
  });

  // ----------------------------------------------------------------- reading

  it('shows a merchant their own destination with the number masked', async () => {
    const merchant = await newMerchant();
    const { client } = stubPaystack({ accountName: 'AKUA BOATENG' });
    const svc = new PayoutAccountService(db, audit, client);

    expect(await svc.get(merchant.id)).toEqual({
      connected: false,
      bank_code: null,
      account_number_masked: null,
      account_name: null,
    });

    await svc.set(merchant.id, { bank_code: 'MTN', account_number: '0244771122' }, SYSTEM_ACTOR);

    expect(await svc.get(merchant.id)).toEqual({
      connected: true,
      bank_code: 'MTN',
      account_number_masked: '••••1122',
      account_name: 'AKUA BOATENG',
    });
  });

  it('treats an unknown merchant as absent rather than reaching the provider', async () => {
    const { client, calls } = stubPaystack();
    const svc = new PayoutAccountService(db, audit, client);

    await expect(svc.get(randomUUID())).rejects.toBeInstanceOf(MerchantNotFoundError);
    await expect(
      svc.resolve(randomUUID(), { bank_code: 'MTN', account_number: '0244771122' }),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
    expect(calls.resolve).toHaveLength(0);
  });
});
