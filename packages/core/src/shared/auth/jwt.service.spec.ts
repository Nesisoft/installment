import { describe, expect, it } from 'vitest';
import { JwtExpiredError, JwtInvalidError, JwtService } from './jwt.service';

const base = { accessSecret: 'access-secret', refreshSecret: 'refresh-secret' };

describe('JwtService', () => {
  it('throws without both secrets', () => {
    expect(() => new JwtService({ accessSecret: '', refreshSecret: 'x' })).toThrow(/required/);
  });

  it('round-trips an access token preserving claims', () => {
    const svc = new JwtService(base);
    const token = svc.signAccess({ sub: 'user-1', user_type: 'admin' });
    const claims = svc.verifyAccess(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.user_type).toBe('admin');
    expect(claims.type).toBe('access');
  });

  it('round-trips a refresh token', () => {
    const svc = new JwtService(base);
    const claims = svc.verifyRefresh(svc.signRefresh({ sub: 'user-1' }));
    expect(claims.type).toBe('refresh');
    expect(claims.sub).toBe('user-1');
  });

  it('refuses an access token presented to verifyRefresh and vice-versa', () => {
    const svc = new JwtService(base);
    expect(() => svc.verifyRefresh(svc.signAccess({ sub: 'u' }))).toThrow(JwtInvalidError);
    expect(() => svc.verifyAccess(svc.signRefresh({ sub: 'u' }))).toThrow(JwtInvalidError);
  });

  it('rejects a token signed with the wrong secret', () => {
    const signer = new JwtService(base);
    const other = new JwtService({ accessSecret: 'different', refreshSecret: 'x' });
    expect(() => other.verifyAccess(signer.signAccess({ sub: 'u' }))).toThrow(JwtInvalidError);
  });

  it('rejects a tampered token', () => {
    const svc = new JwtService(base);
    const token = svc.signAccess({ sub: 'u' });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => svc.verifyAccess(tampered)).toThrow(JwtInvalidError);
  });

  it('throws JwtExpiredError for an expired token', () => {
    const svc = new JwtService({ ...base, accessTtlSeconds: -10 });
    expect(() => svc.verifyAccess(svc.signAccess({ sub: 'u' }))).toThrow(JwtExpiredError);
  });

  it('enforces issuer when configured', () => {
    const signer = new JwtService({ ...base, issuer: 'installment-a' });
    const verifier = new JwtService({ ...base, issuer: 'installment-b' });
    expect(() => verifier.verifyAccess(signer.signAccess({ sub: 'u' }))).toThrow(JwtInvalidError);
  });
});
