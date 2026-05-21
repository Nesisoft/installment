import { describe, expect, it } from 'vitest';
import { OtpService, type OtpStore } from './otp.service';

class FakeOtpStore implements OtpStore {
  map = new Map<string, string>();
  set(key: string, value: string, _ttlMs: number): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  del(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

const TARGET = '+233244123456';

describe('OtpService', () => {
  it('issues a zero-padded code of the configured length', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store, { codeLength: 6 });
    const { code, expiresAt } = await svc.start(TARGET);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(store.map.has(`otp:${TARGET}`)).toBe(true);
  });

  it('verifies a correct code once and burns it', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store);
    const { code } = await svc.start(TARGET);
    expect(await svc.verify(TARGET, code)).toBe(true);
    // Burned — a replay fails.
    expect(await svc.verify(TARGET, code)).toBe(false);
    expect(store.map.has(`otp:${TARGET}`)).toBe(false);
  });

  it('rejects a wrong code and burns after maxAttempts', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store, { maxAttempts: 3 });
    await svc.start(TARGET);
    expect(await svc.verify(TARGET, '000000')).toBe(false);
    expect(await svc.verify(TARGET, '000001')).toBe(false);
    expect(store.map.has(`otp:${TARGET}`)).toBe(true); // still alive (2 < 3)
    expect(await svc.verify(TARGET, '000002')).toBe(false); // 3rd attempt burns it
    expect(store.map.has(`otp:${TARGET}`)).toBe(false);
  });

  it('returns false for an expired code and removes it', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store);
    const { code } = await svc.start(TARGET);

    // Force expiry by rewriting the stored record's expiresAt into the past.
    const key = `otp:${TARGET}`;
    const rec = JSON.parse(store.map.get(key)!);
    rec.expiresAt = Date.now() - 1;
    store.map.set(key, JSON.stringify(rec));

    expect(await svc.verify(TARGET, code)).toBe(false);
    expect(store.map.has(key)).toBe(false);
  });

  it('returns false when no code was issued', async () => {
    const svc = new OtpService(new FakeOtpStore());
    expect(await svc.verify(TARGET, '123456')).toBe(false);
  });

  it('isolates codes per target', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store);
    const a = await svc.start('+233200000001');
    const b = await svc.start('+233200000002');
    expect(await svc.verify('+233200000001', b.code)).toBe(false);
    expect(await svc.verify('+233200000001', a.code)).toBe(true);
  });
});
