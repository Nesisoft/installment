import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService, type OtpStore } from '../../shared/auth/otp.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { UsersService } from '../users/users.service';
import { AuthService, type SmsSender } from './auth.service';
import {
  AccountInactiveError,
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
  del(k: string): Promise<void> {
    this.map.delete(k);
    return Promise.resolve();
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
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
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
    await users.createMerchantUser(
      { email: e, name: 'Owner', password: 'longenough', roleNames: ['admin'] },
      SYSTEM_ACTOR,
    );
    const auth = makeAuth();

    const result = await auth.passwordLogin({ email: e, password: 'longenough' });
    expect(result.userType).toBe('merchant');
    expect(result.permissions).toContain('merchants:write');
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
});
