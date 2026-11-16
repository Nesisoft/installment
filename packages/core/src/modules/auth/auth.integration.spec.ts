import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService, type OtpStore } from '../../shared/auth/otp.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { UsersService } from '../users/users.service';
import { AuthService, type SmsSender } from './auth.service';
import {
  AccountInactiveError,
  CurrentPasswordIncorrectError,
  InvalidCredentialsError,
  InvalidOtpError,
  InvalidTokenError,
} from './errors';

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

class CapturingSms implements SmsSender {
  sent: Array<{ to: string; message: string }> = [];
  send(msg: { to: string; sender: string; message: string }): Promise<unknown> {
    this.sent.push({ to: msg.to, message: msg.message });
    return Promise.resolve({ ok: true });
  }
}

describe.skipIf(!RUN_DB)('AuthService (integration)', () => {
  const { db, pool } = createTestDb();
  const passwords = new PasswordService(4);
  const users = new UsersService(db, new AuditLogger(), passwords);
  const jwt = new JwtService({ accessSecret: 'access-test', refreshSecret: 'refresh-test' });
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  function makeAuth(sms?: CapturingSms) {
    return new AuthService({
      users,
      passwords,
      jwt,
      otp: new OtpService(new MemoryOtpStore()),
      sms,
      smsSenderId: 'Installmt',
    });
  }

  const email = () => `merchant+${randomUUID()}@x.gh`;
  const phone = () => `+23324${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

  it('logs a merchant in with email + password and returns tokens + permissions', async () => {
    const e = email();
    // The merchant's own role. This once granted `admin` to get a permission
    // back, which a merchant login can no longer hold: merchant_owner carries
    // no console permissions, and the merchant routes scope by merchant id.
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();

    const result = await auth.passwordLogin({ email: e, password: 'longenough' });
    expect(result.userType).toBe('merchant');
    expect(result.permissions).toEqual([]);
    // A seller chose their own password at signup.
    expect(result.mustChangePassword).toBe(false);
    const claims = jwt.verifyAccess(result.tokens.accessToken);
    expect(claims.sub).toBe(result.userId);
    expect(claims.user_type).toBe('merchant');
  });

  it('rejects a wrong password and an unknown email identically', async () => {
    const e = email();
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();
    await expect(auth.passwordLogin({ email: e, password: 'wrong' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(
      auth.passwordLogin({ email: email(), password: 'whatever' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('runs the customer OTP flow end-to-end via the SMS sender', async () => {
    const p = phone();
    await users.createCustomerUser({ phone: p, name: 'Ama' }, SYSTEM_ACTOR);
    const sms = new CapturingSms();
    const auth = makeAuth(sms);

    const { expiresAt } = await auth.customerOtpStart({ phone: p });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sms.sent).toHaveLength(1);
    const code = sms.sent[0]!.message.match(/\b(\d{6})\b/)![1]!;

    const result = await auth.customerOtpVerify({ phone: p, code });
    expect(result.userType).toBe('customer');
    expect(result.permissions).toEqual([]); // 'customer' role has no granted permissions yet
    expect(jwt.verifyAccess(result.tokens.accessToken).sub).toBe(result.userId);
  });

  it('rejects a wrong OTP code', async () => {
    const p = phone();
    await users.createCustomerUser({ phone: p, name: 'Ama' }, SYSTEM_ACTOR);
    const auth = makeAuth(new CapturingSms());
    await auth.customerOtpStart({ phone: p });
    await expect(auth.customerOtpVerify({ phone: p, code: '000000' })).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
  });

  it('rotates tokens on refresh and rejects a tampered refresh token', async () => {
    const e = email();
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();
    const { tokens } = await auth.passwordLogin({ email: e, password: 'longenough' });

    const rotated = await auth.refresh({ refreshToken: tokens.refreshToken });
    expect(jwt.verifyAccess(rotated.accessToken).sub).toBe(
      jwt.verifyRefresh(tokens.refreshToken).sub,
    );

    await expect(
      auth.refresh({ refreshToken: `${tokens.refreshToken}tamper` }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('refuses an access token presented to refresh()', async () => {
    const e = email();
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();
    const { tokens } = await auth.passwordLogin({ email: e, password: 'longenough' });
    await expect(auth.refresh({ refreshToken: tokens.accessToken })).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('blocks login for a deactivated user', async () => {
    const e = email();
    const user = await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    // Deactivate directly.
    const { schema } = await import('@installment/db');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.users).set({ is_active: false }).where(eq(schema.users.id, user.id));

    const auth = makeAuth();
    await expect(auth.passwordLogin({ email: e, password: 'longenough' })).rejects.toBeInstanceOf(
      AccountInactiveError,
    );
  });
  // --- Passwords and sessions ------------------------------------------------

  const staffActor = (id: string) => ({ actorId: id, actorType: 'admin' as const });

  async function newStaff(password = 'chosen-by-admin') {
    const e = `staff+${randomUUID()}@ops.gh`;
    const user = await users.createStaff(
      { email: e, name: 'Esi', password, user_type: 'agent', roleNames: ['ops'] },
      SYSTEM_ACTOR,
    );
    return { e, user };
  }

  it('signs new staff in with nothing but the duty to choose their own password', async () => {
    const { e } = await newStaff();
    const auth = makeAuth();

    const first = await auth.passwordLogin({ email: e, password: 'chosen-by-admin' });
    expect(first.mustChangePassword).toBe(true);
    expect(first.permissions).toEqual([]);

    const changed = await auth.changePassword(
      first.userId,
      { current_password: 'chosen-by-admin', new_password: 'my-own-secret' },
      staffActor(first.userId),
    );
    expect(changed.mustChangePassword).toBe(false);
    expect(changed.permissions.length).toBeGreaterThan(0);
    expect(jwt.verifyAccess(changed.tokens.accessToken).sub).toBe(first.userId);

    await expect(
      auth.passwordLogin({ email: e, password: 'chosen-by-admin' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const again = await auth.passwordLogin({ email: e, password: 'my-own-secret' });
    expect(again.mustChangePassword).toBe(false);
  });

  it('ends every other session when the password changes, and keeps the one that changed it', async () => {
    const e = email();
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();
    const phoneSession = await auth.passwordLogin({ email: e, password: 'longenough' });
    const laptopSession = await auth.passwordLogin({ email: e, password: 'longenough' });

    const changed = await auth.changePassword(
      laptopSession.userId,
      { current_password: 'longenough', new_password: 'longer-still' },
      { actorId: laptopSession.userId, actorType: 'merchant' },
    );

    await expect(
      auth.refresh({ refreshToken: phoneSession.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      auth.refresh({ refreshToken: laptopSession.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    const rotated = await auth.refresh({ refreshToken: changed.tokens.refreshToken });
    // And the rotated pair keeps working: it carries the new version too.
    await expect(auth.refresh({ refreshToken: rotated.refreshToken })).resolves.toBeDefined();
  });

  it('refuses a wrong or unchanged current password without ending the session', async () => {
    const e = email();
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();
    const session = await auth.passwordLogin({ email: e, password: 'longenough' });
    const self = { actorId: session.userId, actorType: 'merchant' as const };

    await expect(
      auth.changePassword(
        session.userId,
        { current_password: 'not-it', new_password: 'longer-still' },
        self,
      ),
    ).rejects.toBeInstanceOf(CurrentPasswordIncorrectError);
    await expect(
      auth.changePassword(
        session.userId,
        { current_password: 'longenough', new_password: 'longenough' },
        self,
      ),
    ).rejects.toThrow(/different from the current one/);
    await expect(
      auth.changePassword(
        session.userId,
        { current_password: 'longenough', new_password: 'short' },
        self,
      ),
    ).rejects.toThrow();

    // None of that touched the session.
    await expect(
      auth.refresh({ refreshToken: session.tokens.refreshToken }),
    ).resolves.toBeDefined();
    await expect(auth.passwordLogin({ email: e, password: 'longenough' })).resolves.toBeDefined();
  });

  it('has no password to change for a shopper who signs in with a code', async () => {
    const p = phone();
    const customer = await users.createCustomerUser({ phone: p, name: 'Ama' }, SYSTEM_ACTOR);
    await expect(
      makeAuth().changePassword(
        customer.id,
        { current_password: 'anything', new_password: 'longer-still' },
        { actorId: customer.id, actorType: 'customer' },
      ),
    ).rejects.toBeInstanceOf(CurrentPasswordIncorrectError);
  });

  it('signs a reset member of staff out everywhere and back in on the temporary password', async () => {
    const lead = await newStaff();
    await users.changeOwnPassword(lead.user.id, 'leads-own-1', staffActor(lead.user.id));
    const { e, user } = await newStaff();
    const auth = makeAuth();
    const own = await auth.changePassword(
      user.id,
      { current_password: 'chosen-by-admin', new_password: 'agents-own-1' },
      staffActor(user.id),
    );

    await users.resetStaffPassword(
      user.id,
      { temporary_password: 'Temp-Pass-123', reason: 'Lost their phone' },
      staffActor(lead.user.id),
    );

    await expect(auth.refresh({ refreshToken: own.tokens.refreshToken })).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(auth.passwordLogin({ email: e, password: 'agents-own-1' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    const temp = await auth.passwordLogin({ email: e, password: 'Temp-Pass-123' });
    expect(temp.mustChangePassword).toBe(true);
    expect(temp.permissions).toEqual([]);
  });

  it('still accepts a refresh token from before token versions existed', async () => {
    const e = email();
    const user = await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough' },
      SYSTEM_ACTOR,
    );
    // What every refresh token issued before this change looks like: no `tv`.
    const legacy = jwt.signRefresh({ sub: user.id, user_type: 'merchant' });
    const auth = makeAuth();
    await expect(auth.refresh({ refreshToken: legacy })).resolves.toBeDefined();

    await auth.changePassword(
      user.id,
      { current_password: 'longenough', new_password: 'longer-still' },
      { actorId: user.id, actorType: 'merchant' },
    );
    await expect(auth.refresh({ refreshToken: legacy })).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
