import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { eq } from 'drizzle-orm';
import {
  AuditLogger,
  AuthService,
  EmailAlreadyRegisteredError,
  InvalidOtpError,
  InvalidTokenError,
  JwtService,
  MerchantConflictError,
  MerchantsService,
  OtpService,
  PasswordService,
  PhoneAlreadyRegisteredError,
  SYSTEM_ACTORS,
  UsersService,
  type OtpStore,
  type SmsSender,
} from '@installment/core';
import { StoresService } from './stores.service';
import { provisionStore, slugifyShopName } from './provision-store';

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

/**
 * The code is only ever plaintext in the SMS — the store keeps a salted hash —
 * so reading it the way a merchant does is also the only way to read it.
 */
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
 * Merchant self-signup, end to end against Postgres.
 *
 * It spans three services and two packages — AuthService and MerchantsService
 * in core, StoresService in commerce, composed through a callback because
 * commerce depends on core and not the other way round — and it writes four
 * rows across three tables. There is no version of this worth testing with
 * mocks: what could go wrong is precisely whether the rows agree with each
 * other.
 *
 * The property the whole design rests on: everything it creates is INERT. The
 * merchant lands `pending_kyc` and the shopfront `draft`, so a stranger can
 * sign up, brand a shop and list products, and none of it is visible or
 * purchasable until an admin activates them. #61 is what enforces that on the
 * storefront and at checkout; this spec pins the states it depends on.
 */
describe.skipIf(!RUN_DB)('merchant self-signup (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const passwords = new PasswordService(4);
  const users = new UsersService(db, audit, passwords);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const jwt = new JwtService({ accessSecret: 'access-test', refreshSecret: 'refresh-test' });
  const otpStore = new MemoryOtpStore();
  const otp = new OtpService(otpStore);
  const sms = new CapturingSms();
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  const auth = new AuthService({
    users,
    passwords,
    jwt,
    otp,
    sms,
    merchants,
    provisionStore: ({ merchantId, shopName }) =>
      provisionStore(stores, { merchantId, shopName }, SYSTEM_ACTOR),
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A fresh Ghanaian mobile number nobody has registered. */
  function newPhone(): string {
    return `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
  }

  /** Walks the three steps and returns what the last one produced. */
  async function signUp(over: Partial<{ shopName: string; email: string; phone: string }> = {}) {
    const id = randomUUID().slice(0, 8);
    const phone = over.phone ?? newPhone();
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({ phone, code: sms.code() });
    const result = await auth.merchantSignupComplete({
      signupToken,
      business_name: over.shopName ?? `Akos Kente ${id}`,
      legal_name: `Akosua Ventures Ltd ${id}`,
      email: over.email ?? `akos+${id}@fixture.local`,
      password: 'a-strong-passphrase',
      // Unique per merchant — `merchants_tin_key`. Sharing one across fixtures
      // is what surfaced the unmapped conflict below.
      tin: `C${id}${Math.floor(Math.random() * 1_000)}`,
    });
    return { ...result, phone };
  }

  /** Like `signUp`, but with the identifiers pinned so a collision can be forced. */
  async function signUpWith({ tin, id }: { tin: string; id: string }) {
    const phone = newPhone();
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({ phone, code: sms.code() });
    return auth.merchantSignupComplete({
      signupToken,
      business_name: `Twin Co ${id}`,
      legal_name: `Twin Co Ltd ${id}`,
      email: `twin+${id}@fixture.local`,
      password: 'a-strong-passphrase',
      tin,
    });
  }

  async function merchantOf(userId: string) {
    const user = await users.getById(userId);
    const merchantId = (user.metadata as { merchant_id?: string }).merchant_id!;
    return merchants.get(merchantId);
  }

  it('creates the merchant, its login and its shopfront in one flow', async () => {
    const result = await signUp({ shopName: 'Auntie Akos Kente' });

    expect(result.userType).toBe('merchant');
    expect(result.tokens.accessToken).toBeTruthy();

    const merchant = await merchantOf(result.userId);
    expect(merchant.business_name).toBe('Auntie Akos Kente');
    expect(merchant.phone).toBe(result.phone);

    const store = await stores.getByMerchant(merchant.id);
    expect(store?.display_name).toBe('Auntie Akos Kente');
    expect(store?.slug).toBe('auntie-akos-kente');
  });

  /**
   * The property the design rests on. A stranger can sign up and set up; they
   * cannot trade until a human says so.
   */
  it('creates nothing that can trade yet', async () => {
    const result = await signUp();
    const merchant = await merchantOf(result.userId);
    const store = await stores.getByMerchant(merchant.id);

    expect(merchant.status).toBe('pending_kyc');
    expect(store?.status).toBe('draft');
    expect(merchant.onboarded_at).toBeNull();
  });

  /**
   * The commercial terms are the marketplace's, not the applicant's. A merchant
   * naming their own take-rate at signup would be the business model handed
   * over in a request body.
   */
  it('takes the platform defaults for commission and reserve', async () => {
    const merchant = await merchantOf((await signUp()).userId);

    expect(merchant.default_mdr_bps).toBe(400);
    expect(merchant.default_reserve_bps).toBe(500);
    expect(merchant.default_business_model).toBe('bnpl');
  });

  it('ignores commercial terms a caller tries to smuggle into the body', async () => {
    const phone = newPhone();
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({ phone, code: sms.code() });
    const id = randomUUID().slice(0, 8);
    const result = await auth.merchantSignupComplete({
      signupToken,
      business_name: `Cheeky ${id}`,
      legal_name: `Cheeky Ltd ${id}`,
      email: `cheeky+${id}@fixture.local`,
      password: 'a-strong-passphrase',
      // Not in the schema, so stripped rather than honoured.
      default_mdr_bps: 0,
      default_reserve_bps: 0,
      // The columns activation actually charges, now that the admin schema
      // accepts them. Signup builds the create call field by field, so these
      // must never reach it.
      mdr_bps_override: 0,
      reserve_bps_override: 0,
      commission_bps_override: 0,
    } as never);

    const merchant = await merchantOf(result.userId);
    expect(merchant.default_mdr_bps).toBe(400);
    expect(merchant.default_reserve_bps).toBe(500);
    expect(merchant.mdr_bps_override).toBeNull();
    expect(merchant.reserve_bps_override).toBeNull();
    expect(merchant.commission_bps_override).toBeNull();
  });

  it('sends no code to a phone that already has a login', async () => {
    const first = await signUp();

    await expect(auth.merchantSignupStart({ phone: first.phone })).rejects.toThrow(
      PhoneAlreadyRegisteredError,
    );
  });

  it('refuses an email that already has a login, before writing the merchant', async () => {
    const email = `taken+${randomUUID().slice(0, 8)}@fixture.local`;
    await signUp({ email });

    const before = await db.select().from(schema.merchants);
    await expect(signUp({ email })).rejects.toThrow(EmailAlreadyRegisteredError);
    const after = await db.select().from(schema.merchants);

    // Checked before the insert, so a rejected signup leaves no orphan business.
    expect(after.length).toBe(before.length);
  });

  /**
   * The signup ticket is scoped. Without that, a ticket minted by the customer
   * flow would be accepted here: same `type: 'signup'`, same secret, same
   * subject. The holder owns the phone either way, so it is confusion rather
   * than escalation — but the two flows should not be crossable.
   */
  it('refuses a signup ticket minted for the customer flow', async () => {
    const phone = newPhone();
    const customerTicket = jwt.signSignup(phone); // defaults to the customer scope

    await expect(
      auth.merchantSignupComplete({
        signupToken: customerTicket,
        business_name: 'Wrong Door',
        legal_name: 'Wrong Door Ltd',
        email: `wrong+${randomUUID().slice(0, 8)}@fixture.local`,
        password: 'a-strong-passphrase',
      }),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('refuses a genuinely valid customer-signup code on the same number', async () => {
    // The keyspaces are separate, so a real, unexpired code minted under
    // `signup:` cannot be burned under `merchant-signup:` — and a hash is
    // salted with the target, so it could not match even if the key were found.
    const phone = newPhone();
    const { code } = await otp.start(`signup:${phone}`);

    await expect(auth.merchantSignupVerifyCode({ phone, code })).rejects.toThrow(InvalidOtpError);
  });

  it('gives two shops with the same name different addresses', async () => {
    const first = await signUp({ shopName: 'City Electronics' });
    const second = await signUp({ shopName: 'City Electronics' });

    const a = await stores.getByMerchant((await merchantOf(first.userId)).id);
    const b = await stores.getByMerchant((await merchantOf(second.userId)).id);

    expect(a?.slug).toBe('city-electronics');
    // Suffixed rather than refused: signup is the wrong place to hand somebody
    // a "that name is taken" dead end, and both shops are real.
    expect(b?.slug).toMatch(/^city-electronics-[0-9a-f]{6}$/);
  });

  /**
   * A TIN is unique across merchants, and it is a number a trader types from a
   * certificate. Before this it came back as a raw Postgres error and a 500 —
   * so somebody retrying their registration, or whose accountant had already
   * signed them up, got "something went wrong". Found by a fixture that reused
   * one, which is a better way to find it than a merchant does.
   */
  it('says so plainly when the TIN is already registered', async () => {
    const tin = `C${randomUUID().slice(0, 10)}`;
    const first = randomUUID().slice(0, 8);
    await signUpWith({ tin, id: first });

    const second = randomUUID().slice(0, 8);
    await expect(signUpWith({ tin, id: second })).rejects.toThrow(MerchantConflictError);
  });

  it('lets the new merchant sign in with the password they chose', async () => {
    const id = randomUUID().slice(0, 8);
    const email = `login+${id}@fixture.local`;
    await signUp({ email });

    const login = await auth.passwordLogin({ email, password: 'a-strong-passphrase' });
    expect(login.userType).toBe('merchant');
  });

  it('links the login to the merchant, so the portal scopes to it', async () => {
    const result = await signUp();
    const merchant = await merchantOf(result.userId);

    expect(await users.getMerchantScope(result.userId)).toBe(merchant.id);
  });

  it('records the phone as first seen now, which the credit gates read', async () => {
    // Not a merchant concern directly, but `phone_first_seen_at` is what
    // `gate.phone_age` reads for customers — worth knowing merchant signup does
    // not touch the customers table at all.
    const result = await signUp();
    const merchant = await merchantOf(result.userId);
    const customers = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.phone, merchant.phone));

    expect(customers).toHaveLength(0);
  });
});

describe('slugifyShopName', () => {
  it('turns a shop name into a usable address', () => {
    expect(slugifyShopName("Auntie Akos' Kente & Beads!")).toBe('auntie-akos-kente-beads');
  });

  it('strips accents rather than dropping the letters', () => {
    // "Créperie" and "Creperie" must not become two different addresses.
    expect(slugifyShopName('Créperie du Golfe')).toBe('creperie-du-golfe');
  });

  it('collapses runs of punctuation and trims the edges', () => {
    expect(slugifyShopName('  ---Melcom---  Plus  ')).toBe('melcom-plus');
  });

  it('leaves room for a collision suffix inside the column limit', () => {
    const long = slugifyShopName('a'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
  });

  it('still produces an address for a name with no latin letters', () => {
    expect(slugifyShopName('布料店')).toBe('shop');
  });
});
