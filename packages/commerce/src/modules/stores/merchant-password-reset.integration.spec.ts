import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  AccountInactiveError,
  AuditLogger,
  AuthService,
  InvalidCredentialsError,
  InvalidOtpError,
  InvalidTokenError,
  JwtService,
  MerchantsService,
  OtpService,
  PasswordService,
  SYSTEM_ACTORS,
  UsersService,
  type OtpStore,
  type SmsSender,
} from '@installment/core';
import { StoresService } from './stores.service';
import { provisionStore } from './provision-store';

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
  del(k: string): Promise<number> {
    return Promise.resolve(this.map.delete(k) ? 1 : 0);
  }
  incr(k: string): Promise<number> {
    const n = Number(this.map.get(k) ?? 0) + 1;
    this.map.set(k, String(n));
    return Promise.resolve(n);
  }
}

/** Every SMS sent, so a test can read a code the way the seller would. */
class CapturingSms implements SmsSender {
  sent: Array<{ to: string; message: string }> = [];
  send(msg: { to: string; sender: string; message: string }): Promise<unknown> {
    this.sent.push({ to: msg.to, message: msg.message });
    return Promise.resolve({ ok: true });
  }
  codeFor(phone: string): string {
    const last = [...this.sent].reverse().find((m) => m.to === phone);
    const match = /\b(\d{4,8})\b/.exec(last?.message ?? '');
    if (!match) throw new Error(`no code sent to ${phone}`);
    return match[1]!;
  }
}

/**
 * A seller who has forgotten their password, end to end against Postgres.
 *
 * Here rather than in core because it needs a shop opened the way sellers open
 * one — self-signup, which provisions the shopfront through commerce — so the
 * phone, the merchant and its login are linked exactly as in production.
 */
describe.skipIf(!RUN_DB)('merchant password reset (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const passwords = new PasswordService(4);
  const users = new UsersService(db, audit, passwords);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const jwt = new JwtService({ accessSecret: 'access-test', refreshSecret: 'refresh-test' });
  const otp = new OtpService(new MemoryOtpStore());
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

  const newPhone = () => `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;

  /** Opens a shop through self-signup; returns its phone, email and session. */
  async function openShop() {
    const id = randomUUID().slice(0, 8);
    const phone = newPhone();
    const email = `reset+${id}@fixture.local`;
    await auth.merchantSignupStart({ phone });
    const { signupToken } = await auth.merchantSignupVerifyCode({
      phone,
      code: sms.codeFor(phone),
    });
    const session = await auth.merchantSignupComplete({
      signupToken,
      business_name: `Reset Co ${id}`,
      legal_name: `Reset Co Ltd ${id}`,
      email,
      password: 'the-forgotten-one',
      tin: `R${id}${Math.floor(Math.random() * 1_000)}`,
    });
    return { phone, email, session };
  }

  async function resetTo(phone: string, newPassword: string) {
    await auth.merchantPasswordResetStart({ phone });
    const { resetToken } = await auth.merchantPasswordResetVerifyCode({
      phone,
      code: sms.codeFor(phone),
    });
    return auth.merchantPasswordResetComplete({ resetToken, new_password: newPassword });
  }

  it('resets a forgotten password by a code to the shop phone, and signs the seller in', async () => {
    const { phone, email, session } = await openShop();
    const before = sms.sent.length;

    const result = await resetTo(phone, 'remembered-now-1');

    const text = sms.sent[before]!;
    expect(text.to).toBe(phone);
    expect(text.message).toMatch(/password reset code/);
    expect(result.userId).toBe(session.userId);
    expect(result.userType).toBe('merchant');
    expect(result.mustChangePassword).toBe(false);
    expect(jwt.verifyAccess(result.tokens.accessToken).sub).toBe(session.userId);

    await expect(
      auth.passwordLogin({ email, password: 'the-forgotten-one' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(
      auth.passwordLogin({ email, password: 'remembered-now-1' }),
    ).resolves.toMatchObject({ userId: session.userId });

    const [row] = await db
      .select()
      .from(schema.audit_events)
      .where(
        and(
          eq(schema.audit_events.entity_id, session.userId),
          eq(schema.audit_events.event_type, 'user.password_recovered'),
        ),
      )
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    expect(row).toMatchObject({ actor_id: session.userId, actor_type: 'merchant' });
  });

  it('signs out every session the seller had before the reset', async () => {
    const { phone, session } = await openShop();
    const result = await resetTo(phone, 'remembered-now-1');

    await expect(
      auth.refresh({ refreshToken: session.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(auth.refresh({ refreshToken: result.tokens.refreshToken })).resolves.toBeDefined();
  });

  it('answers the same for a number with no shop, and texts it nothing', async () => {
    const stranger = newPhone();
    const before = sms.sent.length;

    const answer = await auth.merchantPasswordResetStart({ phone: stranger });

    expect(answer.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sms.sent.length).toBe(before);
    await expect(
      auth.merchantPasswordResetVerifyCode({ phone: stranger, code: '123456' }),
    ).rejects.toBeInstanceOf(InvalidOtpError);
  });

  it('takes no code but its own: a signup code cannot reset, a reset ticket cannot open a shop', async () => {
    const { phone } = await openShop();

    // A merchant-signup ticket for the same, proven, phone.
    const signupTicket = jwt.signSignup(phone, 'merchant');
    await expect(
      auth.merchantPasswordResetComplete({
        resetToken: signupTicket,
        new_password: 'x'.repeat(10),
      }),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    // A code sent for something else does not verify a reset.
    await auth.merchantPasswordResetStart({ phone });
    await expect(
      auth.merchantPasswordResetVerifyCode({ phone, code: '000000' }),
    ).rejects.toBeInstanceOf(InvalidOtpError);
    const { resetToken } = await auth.merchantPasswordResetVerifyCode({
      phone,
      code: sms.codeFor(phone),
    });

    // And the reset ticket is no good for opening a shop.
    await expect(
      auth.merchantSignupComplete({
        signupToken: resetToken,
        business_name: 'Squatter',
        legal_name: 'Squatter Ltd',
        email: `squat+${randomUUID().slice(0, 8)}@fixture.local`,
        password: 'a-strong-passphrase',
      }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('burns the code: one reset per code', async () => {
    const { phone } = await openShop();
    await auth.merchantPasswordResetStart({ phone });
    const code = sms.codeFor(phone);
    await auth.merchantPasswordResetVerifyCode({ phone, code });
    await expect(auth.merchantPasswordResetVerifyCode({ phone, code })).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
  });

  it('will not reset a seller whose account Ejua has switched off', async () => {
    const { phone, session } = await openShop();
    await auth.merchantPasswordResetStart({ phone });
    const { resetToken } = await auth.merchantPasswordResetVerifyCode({
      phone,
      code: sms.codeFor(phone),
    });
    await db
      .update(schema.users)
      .set({ is_active: false })
      .where(eq(schema.users.id, session.userId));

    await expect(
      auth.merchantPasswordResetComplete({ resetToken, new_password: 'remembered-now-1' }),
    ).rejects.toBeInstanceOf(AccountInactiveError);
    // And a switched-off seller is not texted a code at all.
    const before = sms.sent.length;
    await auth.merchantPasswordResetStart({ phone });
    expect(sms.sent.length).toBe(before);
  });
});
