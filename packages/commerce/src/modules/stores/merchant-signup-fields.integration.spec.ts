import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  AuditLogger,
  AuthService,
  JwtService,
  MerchantsService,
  OtpService,
  PasswordService,
  PayoutAccountService,
  SYSTEM_ACTORS,
  UsersService,
  approveRequiredMerchantKyc,
  type OtpStore,
  type PayoutRecipientClient,
  type SmsSender,
} from '@installment/core';
import { MediaService } from '../catalog/media';
import { StorefrontService } from '../catalog/storefront.service';
import { StoresService } from './stores.service';
import { provisionStore } from './provision-store';
import { UnknownStoreCategoryError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

class MemoryOtpStore implements OtpStore {
  map = new Map<string, string>();
  set(k: string, v: string): Promise<void> {
    this.map.set(k, v);
    return Promise.resolve();
  }
  get(k: string): Promise<string | null> {
    return Promise.resolve(this.map.get(k) ?? null);
  }
  del(k: string): Promise<void> {
    this.map.delete(k);
    return Promise.resolve();
  }
}

class CapturingSms implements SmsSender {
  last: string | null = null;
  send(msg: { to: string; sender: string; message: string }): Promise<unknown> {
    this.last = msg.message;
    return Promise.resolve({ ok: true });
  }
  code(): string {
    const match = /\b(\d{4,8})\b/.exec(this.last ?? '');
    if (!match) throw new Error(`no code in SMS: ${this.last}`);
    return match[1]!;
  }
}

/**
 * Paystack's Ghana bank list, trimmed to the shape this path reads and using
 * the names and codes the live API returns. Everything else about the flow is
 * real: the same `PayoutAccountService` the payout screen calls, writing the
 * same columns, against the same rows.
 */
function stubPaystack(
  opts: {
    banks?: { name: string; code: string; type: string; currency: string; active?: boolean }[];
    resolveName?: string;
    failResolve?: boolean;
    failList?: boolean;
  } = {},
) {
  const calls: {
    resolved: { accountNumber: string; bankCode: string }[];
    recipients: { type: string; name: string; account_number: string; bank_code: string }[];
  } = { resolved: [], recipients: [] };

  const client: PayoutRecipientClient = {
    listBanks: () => {
      if (opts.failList) return Promise.reject(new Error('Paystack unreachable'));
      return Promise.resolve({
        data: opts.banks ?? [
          { name: 'MTN', code: 'MTN', type: 'mobile_money', currency: 'GHS' },
          { name: 'Vodafone Cash', code: 'VOD', type: 'mobile_money', currency: 'GHS' },
          { name: 'AirtelTigo', code: 'ATL', type: 'mobile_money', currency: 'GHS' },
          { name: 'Ecobank Ghana', code: '130100', type: 'ghipss', currency: 'GHS' },
        ],
      });
    },
    resolveAccount: (accountNumber, bankCode) => {
      calls.resolved.push({ accountNumber, bankCode });
      if (opts.failResolve) return Promise.reject(new Error('Could not resolve account name'));
      return Promise.resolve({
        data: { account_number: accountNumber, account_name: opts.resolveName ?? 'AKOSUA MENSAH' },
      });
    },
    createTransferRecipient: (req) => {
      calls.recipients.push(req);
      return Promise.resolve({ data: { recipient_code: `RCP_${randomUUID().slice(0, 8)}` } });
    },
  };
  return { client, calls };
}

/**
 * The two fields the merchant design collects and self-signup never asked for.
 *
 * Against Postgres and through the real services, because the point of both is
 * where the value ends up: a category that is a foreign key into the same
 * taxonomy the storefront filters products by, and a MoMo number that is never
 * stored as typed — it goes through resolve-then-create-recipient and what
 * lands on the row is an account a bank confirmed.
 *
 * What this cannot prove is that Paystack accepts a real Ghanaian wallet: that
 * needs a live secret key, which this deployment does not have yet. Everything
 * up to the wire is real; the wire is a stub returning the shapes the live API
 * documents.
 */
describe.skipIf(!RUN_DB)('merchant signup fields (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const passwords = new PasswordService(4);
  const users = new UsersService(db, audit, passwords);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const storefront = new StorefrontService(db, new MediaService('https://cdn.test'));
  const jwt = new JwtService({ accessSecret: 'access-test', refreshSecret: 'refresh-test' });
  const otp = new OtpService(new MemoryOtpStore());
  const sms = new CapturingSms();
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  /**
   * The taxonomy this slice files shops under.
   *
   * Inserted rather than assumed: the integration DB is a clone of the
   * migration schema, not of the dev fixtures, so `categories` starts empty.
   * `onConflictDoNothing` because another spec in the same worker may have got
   * here first.
   */
  beforeAll(async () => {
    await db
      .insert(schema.categories)
      .values([
        { name: 'Fashion', slug: 'fashion', position: 1 },
        { name: 'Electronics', slug: 'electronics', position: 2 },
        { name: 'Beauty', slug: 'beauty', position: 3 },
        { name: 'Groceries', slug: 'groceries', position: 4 },
      ])
      .onConflictDoNothing();
    const electronics = (
      await db.select().from(schema.categories).where(eq(schema.categories.slug, 'electronics'))
    )[0]!;
    await db
      .insert(schema.categories)
      .values({ name: 'Laptops', slug: 'laptops', position: 1, parent_id: electronics.id })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A full signup stack, with whatever the wire is doing today. */
  function stack(paystack: PayoutRecipientClient) {
    const payoutAccount = new PayoutAccountService(db, audit, paystack);
    const auth = new AuthService({
      users,
      passwords,
      jwt,
      otp,
      sms,
      merchants,
      assertShopCategory: (slug) => stores.assertCategory(slug),
      provisionStore: ({ merchantId, shopName, categorySlug }) =>
        provisionStore(stores, { merchantId, shopName, categorySlug }, SYSTEM_ACTOR),
      setMobileMoneyPayout: async ({ merchantId, momoNumber, momoProvider }) => {
        await payoutAccount.setMobileMoney(
          merchantId,
          { momo_number: momoNumber, momo_provider: momoProvider },
          { actorId: merchantId, actorType: 'merchant' },
        );
      },
    });
    return { auth, payoutAccount };
  }

  const newPhone = () => `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;

  async function signUp(
    auth: AuthService,
    over: Partial<{
      primary_category_slug: string;
      momo_number: string;
      momo_provider: 'mtn' | 'tgo' | 'vod';
    }> = {},
  ) {
    const id = randomUUID().slice(0, 8);
    const phone = newPhone();
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({ phone, code: sms.code() });
    const result = await auth.merchantSignupComplete({
      signupToken,
      business_name: `Akos Kente ${id}`,
      legal_name: `Akosua Ventures Ltd ${id}`,
      email: `signupfields+${id}@fixture.local`,
      password: 'a-strong-passphrase',
      tin: `C${id}${Math.floor(Math.random() * 1_000)}`,
      ...over,
    });
    return { ...result, phone };
  }

  async function merchantOf(userId: string) {
    const user = await users.getById(userId);
    return merchants.get((user.metadata as { merchant_id?: string }).merchant_id!);
  }

  // ----------------------------------------------------------- the category

  it('files the shop under the same taxonomy the storefront filters products by', async () => {
    const { auth } = stack(stubPaystack().client);
    const result = await signUp(auth, { primary_category_slug: 'electronics' });
    const merchant = await merchantOf(result.userId);

    const store = await stores.getByMerchant(merchant.id);
    const category = (
      await db.select().from(schema.categories).where(eq(schema.categories.slug, 'electronics'))
    )[0];
    // A foreign key into `categories`, not a string of its own. A second list of
    // the same six names would drift, and a shop's category could then never
    // line up with its products'.
    expect(store?.primary_category_id).toBe(category?.id);
  });

  it('shows it on the shopfront, which is the whole reason to ask', async () => {
    const { auth } = stack(stubPaystack().client);
    const result = await signUp(auth, { primary_category_slug: 'fashion' });
    const merchant = await merchantOf(result.userId);
    const store = await stores.getByMerchant(merchant.id);

    // The shop has to be live to be readable at all — signup leaves both inert,
    // which is the property the signup spec next door pins. Activated the way
    // an admin would: KYC approved first, because activation now requires it.
    await approveRequiredMerchantKyc(db, merchant.id, SYSTEM_ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, SYSTEM_ACTOR);
    await stores.transition(store!.id, { event: 'activate' }, SYSTEM_ACTOR);

    const view = await storefront.store(store!.slug);
    expect(view.category).toMatchObject({ slug: 'fashion', name: 'Fashion' });
  });

  it('is optional — a seller who is not sure is not stopped at the door', async () => {
    const { auth } = stack(stubPaystack().client);
    const result = await signUp(auth);
    const merchant = await merchantOf(result.userId);

    const store = await stores.getByMerchant(merchant.id);
    expect(store).toBeTruthy();
    expect(store?.primary_category_id).toBeNull();
  });

  it('refuses a category that does not exist before it writes anything', async () => {
    const { auth } = stack(stubPaystack().client);

    await expect(signUp(auth, { primary_category_slug: 'nonsense' })).rejects.toBeInstanceOf(
      UnknownStoreCategoryError,
    );
  });

  it('refuses a sub-category, so a shop cannot hide under one branch of the tree', async () => {
    // `laptops` is real, and sits under Electronics. A shop filed there would be
    // invisible to anyone browsing Electronics — the taxonomy has one level of
    // shops and two of products.
    const { auth } = stack(stubPaystack().client);
    const child = (
      await db.select().from(schema.categories).where(eq(schema.categories.slug, 'laptops'))
    )[0];
    expect(child?.parent_id).not.toBeNull();

    await expect(signUp(auth, { primary_category_slug: 'laptops' })).rejects.toBeInstanceOf(
      UnknownStoreCategoryError,
    );
  });

  it('leaves no half-made account behind when the category is wrong', async () => {
    const { auth } = stack(stubPaystack().client);
    const id = randomUUID().slice(0, 8);
    const phone = newPhone();
    const email = `retry+${id}@fixture.local`;
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({ phone, code: sms.code() });

    const body = {
      signupToken,
      business_name: `Retry Co ${id}`,
      legal_name: `Retry Co Ltd ${id}`,
      email,
      password: 'a-strong-passphrase',
    };
    await expect(
      auth.merchantSignupComplete({ ...body, primary_category_slug: 'nonsense' }),
    ).rejects.toThrow();

    // The point of checking before the first write: the same person can simply
    // try again. If the merchant row had been created, their email and phone
    // would both be taken and the retry would say so.
    const retried = await auth.merchantSignupComplete({ ...body, primary_category_slug: 'beauty' });
    expect(retried.userType).toBe('merchant');
  });

  // --------------------------------------------------------------- the MoMo

  it('turns a MoMo number into a payout account the bank has confirmed', async () => {
    const { client, calls } = stubPaystack({ resolveName: 'AKOSUA MENSAH' });
    const { auth, payoutAccount } = stack(client);

    const result = await signUp(auth, {
      momo_number: '0244551338',
      momo_provider: 'mtn',
    });
    const merchant = await merchantOf(result.userId);

    // Resolved with the network's own code, in the local form Paystack's Ghana
    // resolution takes — not the +233 canonical form the rest of the system
    // stores, which would come back "account not found".
    expect(calls.resolved).toEqual([{ accountNumber: '0244551338', bankCode: 'MTN' }]);
    expect(calls.recipients[0]).toMatchObject({
      type: 'mobile_money',
      bank_code: 'MTN',
      account_number: '0244551338',
      // The bank's name for the account, never anything the caller supplied.
      name: 'AKOSUA MENSAH',
    });

    expect(merchant.bank_account_name).toBe('AKOSUA MENSAH');
    expect(merchant.bank_code).toBe('MTN');
    expect(merchant.paystack_recipient_code).toMatch(/^RCP_/);

    const view = await payoutAccount.get(merchant.id);
    expect(view).toMatchObject({ connected: true, account_number_masked: '••••1338' });
  });

  it('finds the wallet by name when the code has moved', async () => {
    // Vodafone Cash became Telecel Cash and the same wallet answers to both.
    const { client, calls } = stubPaystack({
      banks: [
        { name: 'Telecel Cash', code: 'TCL', type: 'mobile_money', currency: 'GHS' },
        { name: 'MTN', code: 'MTN', type: 'mobile_money', currency: 'GHS' },
      ],
    });
    const { auth } = stack(client);

    await signUp(auth, { momo_number: '0201234567', momo_provider: 'vod' });

    expect(calls.recipients[0]).toMatchObject({ bank_code: 'TCL', type: 'mobile_money' });
  });

  it('never writes a number the bank did not confirm', async () => {
    // The whole reason the number goes through this flow rather than into a
    // column of its own: a digit typed wrong must leave no payout account, not
    // one that silently fails every night.
    const { client } = stubPaystack({ failResolve: true });
    const { auth, payoutAccount } = stack(client);

    const result = await signUp(auth, { momo_number: '0244000000', momo_provider: 'mtn' });
    const merchant = await merchantOf(result.userId);

    expect(merchant.bank_account_number).toBeNull();
    expect(merchant.bank_code).toBeNull();
    expect(merchant.paystack_recipient_code).toBeNull();
    expect(await payoutAccount.get(merchant.id)).toMatchObject({ connected: false });
  });

  it('still creates the shop when the provider is unreachable', async () => {
    // Which is also the state of this deployment today: no Paystack key, so
    // every signup takes this branch. An account must not be lost to it.
    const { client } = stubPaystack({ failList: true });
    const { auth } = stack(client);

    const result = await signUp(auth, {
      momo_number: '0244551338',
      momo_provider: 'mtn',
      primary_category_slug: 'groceries',
    });
    const merchant = await merchantOf(result.userId);

    expect(result.tokens.accessToken).toBeTruthy();
    expect(merchant.paystack_recipient_code).toBeNull();
    const store = await stores.getByMerchant(merchant.id);
    expect(store).toBeTruthy();
    expect(store?.primary_category_id).not.toBeNull();
  });

  it('refuses a number without its network, and a network without a number', async () => {
    const { auth } = stack(stubPaystack().client);

    await expect(signUp(auth, { momo_number: '0244551338' })).rejects.toThrow();
    await expect(signUp(auth, { momo_provider: 'mtn' })).rejects.toThrow();
  });

  it('accepts the number however it is typed, and resolves the local form', async () => {
    const { client, calls } = stubPaystack();
    const { auth } = stack(client);

    await signUp(auth, { momo_number: '+233 24 455 1338', momo_provider: 'mtn' });

    expect(calls.resolved[0]?.accountNumber).toBe('0244551338');
  });

  it('signs up with neither field, exactly as before', async () => {
    const { client, calls } = stubPaystack();
    const { auth } = stack(client);

    const result = await signUp(auth);
    const merchant = await merchantOf(result.userId);

    expect(result.userType).toBe('merchant');
    expect(calls.resolved).toHaveLength(0);
    expect(merchant.paystack_recipient_code).toBeNull();
  });
});
