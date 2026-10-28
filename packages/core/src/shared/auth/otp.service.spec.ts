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
  del(key: string): Promise<number> {
    return Promise.resolve(this.map.delete(key) ? 1 : 0);
  }
  incr(key: string): Promise<number> {
    const n = Number(this.map.get(key) ?? 0) + 1;
    this.map.set(key, String(n));
    return Promise.resolve(n);
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

  // The store's operations are each atomic, but nothing held verify's steps
  // together: these interleave several verifies at their awaits, as concurrent
  // requests against Redis do.

  it('holds the attempt cap against guesses sent all at once', async () => {
    const store = new FakeOtpStore();
    const svc = new OtpService(store, { maxAttempts: 5 });
    const { code } = await svc.start(TARGET);
    const wrong = code === '000000' ? '000001' : '000000';

    // Twenty at once each read "no attempts yet" and wrote back one, so the
    // cap of five let all twenty through and the code still worked after.
    const results = await Promise.all(Array.from({ length: 20 }, () => svc.verify(TARGET, wrong)));
    expect(results.every((ok) => !ok)).toBe(true);
    expect(await svc.verify(TARGET, code)).toBe(false);
  });

  it('lets one of two simultaneous correct verifies use the code', async () => {
    const svc = new OtpService(new FakeOtpStore());
    const { code } = await svc.start(TARGET);
    const results = await Promise.all([svc.verify(TARGET, code), svc.verify(TARGET, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not bring a used code back when a wrong guess races it', async () => {
    const svc = new OtpService(new FakeOtpStore());
    const { code } = await svc.start(TARGET);
    const wrong = code === '000000' ? '000001' : '000000';
    // The wrong guess read the record before the right one deleted it, then
    // wrote it back with one more attempt — and the used code worked again.
    await Promise.all([svc.verify(TARGET, code), svc.verify(TARGET, wrong)]);
    expect(await svc.verify(TARGET, code)).toBe(false);
  });

  it('gives a new code a fresh count of attempts', async () => {
    const svc = new OtpService(new FakeOtpStore(), { maxAttempts: 3 });
    await svc.start(TARGET);
    await svc.verify(TARGET, 'xxxxxx');
    await svc.verify(TARGET, 'xxxxxx');
    const { code } = await svc.start(TARGET);
    expect(await svc.verify(TARGET, 'xxxxxx')).toBe(false);
    expect(await svc.verify(TARGET, 'xxxxxx')).toBe(false);
    expect(await svc.verify(TARGET, code)).toBe(true);
  });
});
