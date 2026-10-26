import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { runInTransaction } from '../../shared/event-bus/transaction';
import {
  resolvePayoutAccountSchema,
  setPayoutAccountSchema,
  type ResolvePayoutAccountInput,
  type SetPayoutAccountInput,
} from './dto';
import {
  MerchantConflictError,
  MerchantNotFoundError,
  PayoutAccountUnresolvedError,
  PayoutChangeCodeInvalidError,
  PayoutChangeCodeRequiredError,
  UnknownBankError,
} from './errors';
import { type MomoProviderCode } from '../../shared/validators/ghana';
import type { OtpService } from '../../shared/auth/otp.service';
import type { SmsSender } from '../auth/auth.service';
import type { NotificationService } from '../notifications/notification.service';
import type { Merchant, MerchantActor } from './merchants.service';

const m = schema.merchants;
const le = schema.ledger_entries;

/**
 * The slice of the Paystack client this service needs.
 *
 * Narrow on purpose, the same way `PayoutTransferClient` is: core states what
 * it requires and the real client satisfies it structurally, so the tests can
 * hand over a plain object without a network or a secret key.
 */
export interface PayoutRecipientClient {
  listBanks(currency: 'GHS'): Promise<{
    data: { name: string; code: string; type: string; currency: string; active?: boolean }[];
  }>;
  resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<{ data: { account_number: string; account_name: string } }>;
  createTransferRecipient(req: {
    type: 'ghipss' | 'mobile_money';
    name: string;
    account_number: string;
    bank_code: string;
    currency: 'GHS';
  }): Promise<{ data: { recipient_code: string } }>;
}

/** A destination a merchant can pick, flattened for the console's picker. */
export interface PayoutDestination {
  code: string;
  name: string;
  /** `bank` settles over GhIPSS; `mobile_money` is a wallet. */
  kind: 'bank' | 'mobile_money';
}

/** What a merchant is shown about their own payout account. */
export interface PayoutAccountView {
  connected: boolean;
  bank_code: string | null;
  /** Last four digits only — enough to recognise, useless to redirect. */
  account_number_masked: string | null;
  account_name: string | null;
  /**
   * ISO time before which settlement will not pay this account, because it
   * replaced another one recently; null when nothing is held.
   */
  payouts_held_until: string | null;
  /**
   * Whether setting an account from the merchant's session needs the code
   * texted to their phone: when one is already on file, or when money is
   * already owed to them. Clients ask for the code when this is true.
   */
  code_required: boolean;
}

/**
 * What it takes to replace an account a merchant already has: a code texted to
 * the phone on file, and a notice to that phone afterwards.
 *
 * Optional on the constructor so callers that never replace an account (and
 * the fixtures that construct this) need not supply it. Without it a merchant
 * cannot replace their account at all — the check fails closed — while an
 * admin or system caller still can, since neither signs in as the merchant.
 */
export interface PayoutChangeGuard {
  otp: Pick<OtpService, 'start' | 'verify'>;
  sms: SmsSender;
  smsSenderId: string;
  notifications: Pick<NotificationService, 'send'>;
}

/**
 * How long a replaced account waits before settlement pays it. A day is long
 * enough for the real seller to see the notice and call, and short enough that
 * a seller who did make the change is barely inconvenienced: the balance is
 * still owed, and the first run after the hold pays all of it.
 */
export const PAYOUT_ACCOUNT_HOLD_MS = 24 * 60 * 60 * 1_000;

/** Paystack's Ghana list barely changes; refetching it per page view is waste. */
const BANK_CACHE_TTL_MS = 60 * 60 * 1_000;

/**
 * Which Paystack destination each Ghanaian MoMo network corresponds to.
 *
 * Signup asks for a network, because that is what a seller thinks in — "MTN",
 * not "the participant code for MTN Mobile Money". Paystack thinks in bank
 * codes. This is the join.
 *
 * Matched against the live list rather than trusted as a constant, and matched
 * on code *and* name, because either alone has a failure mode: the codes are
 * stable but nothing promises they are, and the names move — Vodafone Cash
 * became Telecel Cash and the same wallet answers to both.
 */
const MOMO_DESTINATIONS: Record<MomoProviderCode, { codes: string[]; name: RegExp }> = {
  mtn: { codes: ['MTN'], name: /\bmtn\b/i },
  vod: { codes: ['VOD'], name: /\b(vodafone|telecel)\b/i },
  tgo: { codes: ['ATL'], name: /\b(airteltigo|airtel|tigo)\b/i },
};

function maskAccountNumber(accountNumber: string | null): string | null {
  if (!accountNumber) return null;
  const tail = accountNumber.slice(-4);
  return `••••${tail}`;
}

/** `+233244123456` → `+233 •••• 3456`: enough to know which phone to look at. */
function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 4)} •••• ${phone.slice(-4)}` : phone;
}

/**
 * The OTP key for one change. It names the destination, so a code asked for
 * one account cannot be spent on another: the text says where the money will
 * go, and that is the only place the code can send it.
 */
function changeTarget(merchantId: string, bankCode: string, accountNumber: string): string {
  return `payout-change:${merchantId}:${bankCode}:${accountNumber}`;
}

/** A timestamptz as Postgres returns it, as ISO — or null. */
function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** `2026-10-27T19:46:00Z` → `27 Oct 2026, 19:46 GMT`. Ghana keeps GMT all year. */
function gmtLabel(at: Date): string {
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${hh}:${mm} GMT`;
}

/**
 * A merchant's own payout destination.
 *
 * Before this, `merchants.paystack_recipient_code` could only be filled by an
 * admin pasting a code out of the Paystack dashboard. A merchant who signed
 * themselves up could sell, ship and accrue a payable balance, and the daily
 * settlement run would skip them every single day with "no Paystack recipient
 * code" — a queue that grows in silence and that nobody outside the logs can
 * see.
 *
 * Deliberately its own service rather than more methods on `MerchantsService`:
 * this is the only merchant operation that talks to a payment provider, and
 * keeping that dependency here means the twenty-odd fixtures that construct a
 * `MerchantsService` do not all have to grow a Paystack stub.
 */
export class PayoutAccountService {
  private banksCache?: { at: number; banks: PayoutDestination[] };

  constructor(
    private readonly db: Database,
    private readonly audit: AuditLogger,
    private readonly paystack: PayoutRecipientClient,
    private readonly guard?: PayoutChangeGuard,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------- banks

  async listDestinations(): Promise<PayoutDestination[]> {
    const cached = this.banksCache;
    if (cached && Date.now() - cached.at < BANK_CACHE_TTL_MS) return cached.banks;

    const res = await this.paystack.listBanks('GHS');
    const banks = (res.data ?? [])
      .filter((b) => b.active !== false && (b.type === 'ghipss' || b.type === 'mobile_money'))
      .map<PayoutDestination>((b) => ({
        code: b.code,
        name: b.name,
        kind: b.type === 'mobile_money' ? 'mobile_money' : 'bank',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.banksCache = { at: Date.now(), banks };
    return banks;
  }

  // ----------------------------------------------------------------- current

  async get(merchantId: string): Promise<PayoutAccountView> {
    const row = await this.load(merchantId);
    const heldUntil = isoOrNull(row.payout_account_hold_until);
    const connected = Boolean(row.paystack_recipient_code);
    return {
      connected,
      code_required: connected || (await this.owedPesewas(merchantId)) > 0,
      bank_code: row.bank_code,
      account_number_masked: maskAccountNumber(row.bank_account_number),
      account_name: row.bank_account_name,
      payouts_held_until:
        heldUntil && new Date(heldUntil).getTime() > this.now().getTime() ? heldUntil : null,
    };
  }

  // ------------------------------------------------------------- change code

  /**
   * Texts the merchant's phone a code that authorises sending their payouts to
   * this one account.
   *
   * Replacing an account used to take only a signed-in session, so anyone
   * holding one — a shared tablet, a borrowed laptop, a phished password —
   * could point every settlement at themselves. The phone on file is the
   * second thing they would also need. It is not editable from the portal.
   */
  async sendChangeCode(
    merchantId: string,
    rawInput: unknown,
  ): Promise<{ sent_to: string; expires_at: string }> {
    const input: ResolvePayoutAccountInput = resolvePayoutAccountSchema.parse(rawInput);
    const merchant = await this.load(merchantId);
    const destination = await this.assertKnownBank(input.bank_code);
    if (!this.guard) throw new PayoutChangeCodeRequiredError();

    const { code, expiresAt } = await this.guard.otp.start(
      changeTarget(merchantId, input.bank_code, input.account_number),
    );
    await this.guard.sms.send({
      to: merchant.phone,
      sender: this.guard.smsSenderId,
      message:
        `${code} is your code to send your payouts to ${destination.name} ` +
        `${maskAccountNumber(input.account_number)}. It expires in 5 minutes. ` +
        `Do not share it with anyone.`,
    });
    return { sent_to: maskPhone(merchant.phone), expires_at: expiresAt.toISOString() };
  }

  // ----------------------------------------------------------------- resolve

  /**
   * Who the bank says owns this account, without writing anything.
   *
   * Split from {@link set} so the console can show the name back before the
   * merchant commits — the one moment a typo is cheap to catch.
   */
  async resolve(
    merchantId: string,
    rawInput: unknown,
  ): Promise<{ account_name: string; account_number: string; bank_code: string }> {
    const input: ResolvePayoutAccountInput = resolvePayoutAccountSchema.parse(rawInput);
    await this.load(merchantId);
    await this.assertKnownBank(input.bank_code);
    const accountName = await this.resolveName(input.account_number, input.bank_code);
    return {
      account_name: accountName,
      account_number: input.account_number,
      bank_code: input.bank_code,
    };
  }

  // -------------------------------------------------------------------- momo

  /**
   * Sets the payout account from a MoMo number and its network.
   *
   * Signup's entry point, and deliberately the *same* {@link set} underneath:
   * the number is resolved with the network and a transfer recipient created
   * before anything is written, so a merchant who typed a digit wrong ends up
   * with no payout account rather than one that silently fails every night.
   *
   * Throws like `set` does. Signup catches — an account is not worth losing
   * over a payout destination that can be added from the portal in a minute —
   * but nothing here decides that on the caller's behalf.
   */
  async setMobileMoney(
    merchantId: string,
    input: { momo_number: string; momo_provider: MomoProviderCode },
    actor: MerchantActor,
  ): Promise<Merchant> {
    const destination = await this.momoDestination(input.momo_provider);
    if (!destination) {
      throw new UnknownBankError(`no ${input.momo_provider} wallet in the provider's list`);
    }
    // Paystack wants the local 0XXXXXXXXX form for a Ghanaian wallet, and
    // `ghPhoneNumber` has already canonicalised the input to +233XXXXXXXXX.
    return this.set(
      merchantId,
      { bank_code: destination.code, account_number: localMomoNumber(input.momo_number) },
      actor,
    );
  }

  /** The live destination for a network, or null when the list has none. */
  async momoDestination(provider: MomoProviderCode): Promise<PayoutDestination | null> {
    const want = MOMO_DESTINATIONS[provider];
    const wallets = (await this.listDestinations()).filter((d) => d.kind === 'mobile_money');
    return (
      wallets.find((d) => want.codes.includes(d.code)) ??
      wallets.find((d) => want.name.test(d.name)) ??
      null
    );
  }

  // --------------------------------------------------------------------- set

  async set(merchantId: string, rawInput: unknown, actor: MerchantActor): Promise<Merchant> {
    const input: SetPayoutAccountInput = setPayoutAccountSchema.parse(rawInput);
    const current = await this.load(merchantId);
    const destination = await this.assertKnownBank(input.bank_code);

    // Guarded: a change that sends money somewhere it was not going. That is a
    // replacement of the account on file — and also a FIRST account when money
    // is already owed, because the session that sets it decides where that
    // balance goes. Only guarding replacements left exactly the merchant a
    // stolen session would want: one who sold before adding an account (a
    // skipped or failed signup payout step), whose whole balance went to
    // whatever account was set first, with no code, hold or notice. A first
    // account on nothing owed, and re-saving the same account, stay free.
    const firstAccount = !current.paystack_recipient_code;
    const changing =
      firstAccount ||
      current.bank_code !== input.bank_code ||
      current.bank_account_number !== input.account_number;
    const guarded = changing && (!firstAccount || (await this.owedPesewas(merchantId)) > 0);
    // The code is asked of the merchant's own session only. An admin or the
    // system does not sign in as the merchant, so a stolen merchant session is
    // not the risk on their path; the hold and the notice below still apply.
    const needsCode = guarded && actor.actorType === 'merchant';
    if (needsCode && !input.code) throw new PayoutChangeCodeRequiredError();

    // Resolved every time, including when the merchant re-confirms a name the
    // console already showed them: the name that reaches Paystack has to be the
    // bank's, or a caller could put someone else's account behind a name of
    // their choosing on the transfer.
    const accountName = await this.resolveName(input.account_number, input.bank_code);

    // Checked after the bank has confirmed the account, so a mistyped number
    // costs the seller a correction rather than their code.
    if (needsCode) {
      const ok = this.guard
        ? await this.guard.otp.verify(
            changeTarget(merchantId, input.bank_code, input.account_number),
            input.code!,
          )
        : false;
      if (!ok) throw new PayoutChangeCodeInvalidError();
    }

    const recipient = await this.paystack.createTransferRecipient({
      type: destination.kind === 'mobile_money' ? 'mobile_money' : 'ghipss',
      name: accountName,
      account_number: input.account_number,
      bank_code: input.bank_code,
      currency: 'GHS',
    });
    const recipientCode = recipient.data?.recipient_code;
    if (!recipientCode) {
      throw new PayoutAccountUnresolvedError('the payment provider returned no recipient code');
    }

    // A guarded change waits a day before settlement pays it: the window for
    // the real seller to see the notice and stop it. An unguarded first account
    // waits for nothing, and re-saving the same account leaves any hold alone.
    const holdUntil = guarded ? new Date(this.now().getTime() + PAYOUT_ACCOUNT_HOLD_MS) : null;

    const updated = await runInTransaction(this.db, async (tx) => {
      // Decided again on the row as it stands, under a lock. Everything above
      // read `current` before two provider round trips, so a save that started
      // while no account was on file could otherwise land on top of one set in
      // the meantime — as an unguarded "first" account.
      const [locked] = await tx
        .select({ recipient: m.paystack_recipient_code })
        .from(m)
        .where(and(eq(m.id, merchantId), isNull(m.deleted_at)))
        .for('update')
        .limit(1);
      if (!locked) throw new MerchantNotFoundError(merchantId);
      if (locked.recipient !== current.paystack_recipient_code) {
        throw new MerchantConflictError(
          'The payout account changed while this one was being saved. Check it and try again.',
        );
      }

      const rows = await tx
        .update(m)
        .set({
          paystack_recipient_code: recipientCode,
          bank_code: input.bank_code,
          bank_account_number: input.account_number,
          bank_account_name: accountName,
          ...(holdUntil ? { payout_account_hold_until: holdUntil.toISOString() } : {}),
        })
        .where(and(eq(m.id, merchantId), isNull(m.deleted_at)))
        .returning();
      const row = rows[0];
      if (!row) throw new MerchantNotFoundError(merchantId);

      // Where the money goes is worth being able to reconstruct later, so the
      // row carries both ends of the change — masked, because an audit log is
      // read by more people than a payout needs.
      await this.audit.append(tx, {
        entityType: 'merchant',
        entityId: merchantId,
        eventType: 'merchant.payout_account_set',
        fromState: current.bank_code
          ? `${current.bank_code}:${maskAccountNumber(current.bank_account_number)}`
          : 'none',
        toState: `${input.bank_code}:${maskAccountNumber(input.account_number)}`,
        actorId: actor.actorId,
        actorType: actor.actorType,
        metadata: {
          account_name: accountName,
          destination: destination.name,
          ...(holdUntil ? { payouts_held_until: holdUntil.toISOString() } : {}),
        },
      });

      return row;
    });

    // To the phone on file, which this change did not touch. Best-effort by
    // NotificationService's own contract: it records a failed send and never
    // throws, so a notice that cannot go out does not undo a change that did.
    if (guarded && holdUntil && this.guard) {
      await this.guard.notifications.send({
        recipientType: 'merchant',
        recipientId: merchantId,
        toAddress: current.phone,
        templateId: 'payout_account_changed',
        variables: {
          destination: destination.name,
          account: maskAccountNumber(input.account_number) ?? '',
          name: accountName,
          until: gmtLabel(holdUntil),
        },
      });
    }

    return updated;
  }

  // ------------------------------------------------------------------ helpers

  /** What settlement would pay this merchant now: their `merchant_payable` balance. */
  private async owedPesewas(merchantId: string): Promise<number> {
    const rows = await this.db
      .select({
        balance: sql<string>`coalesce(sum(${le.amount_pesewas} * case ${le.direction} when 'credit' then 1 else -1 end), 0)`,
      })
      .from(le)
      .where(and(eq(le.account_type, 'merchant_payable'), eq(le.account_ref, merchantId)));
    return Number(rows[0]?.balance ?? 0);
  }

  private async load(merchantId: string): Promise<Merchant> {
    const rows = await this.db
      .select()
      .from(m)
      .where(and(eq(m.id, merchantId), isNull(m.deleted_at)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new MerchantNotFoundError(merchantId);
    return row;
  }

  private async assertKnownBank(bankCode: string): Promise<PayoutDestination> {
    const banks = await this.listDestinations();
    const match = banks.find((b) => b.code === bankCode);
    if (!match) throw new UnknownBankError(bankCode);
    return match;
  }

  /**
   * A provider failure and a rejected account both mean the same thing here —
   * nobody has confirmed who owns this account — so both refuse rather than
   * fall through to creating a recipient on an unchecked number.
   */
  private async resolveName(accountNumber: string, bankCode: string): Promise<string> {
    let resolved: { data: { account_name: string } };
    try {
      resolved = await this.paystack.resolveAccount(accountNumber, bankCode);
    } catch (err) {
      throw new PayoutAccountUnresolvedError(
        err instanceof Error ? err.message : 'the bank could not be reached',
      );
    }
    const name = resolved.data?.account_name?.trim();
    if (!name) throw new PayoutAccountUnresolvedError('no account holder name was returned');
    return name;
  }
}

/**
 * `+233244551338` → `0244551338`.
 *
 * Paystack's Ghana account resolution takes the local form. The canonical E.164
 * that every other part of this system stores would come back "account not
 * found", which reads as a wrong number rather than a wrong format.
 */
function localMomoNumber(e164: string): string {
  return e164.startsWith('+233') ? `0${e164.slice(4)}` : e164;
}
