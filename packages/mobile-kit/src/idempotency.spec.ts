import { describe, expect, it } from 'vitest';
import { idempotent, newIdempotencyKey } from './idempotency';

describe('newIdempotencyKey', () => {
  it('prefixes the key so a log line says what the attempt was', () => {
    expect(newIdempotencyKey('pay-momo')).toMatch(/^pay-momo-/);
  });

  it('never repeats — a reused key would replay someone else’s charge', () => {
    const keys = new Set(Array.from({ length: 2_000 }, () => newIdempotencyKey('k')));
    expect(keys.size).toBe(2_000);
  });

  it('stays inside the 255-character header limit the API enforces', () => {
    expect(newIdempotencyKey('checkout').length).toBeLessThanOrEqual(255);
  });

  it('works without crypto.randomUUID, which Hermes may not expose', () => {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    const original = g.crypto?.randomUUID;
    if (g.crypto) delete g.crypto.randomUUID;
    try {
      const keys = new Set(Array.from({ length: 500 }, () => newIdempotencyKey('k')));
      expect(keys.size).toBe(500);
    } finally {
      if (g.crypto && original) g.crypto.randomUUID = original;
    }
  });
});

describe('idempotent', () => {
  it('produces the header the API requires', () => {
    const config = idempotent('checkout');
    expect(config.headers['Idempotency-Key']).toMatch(/^checkout-/);
  });
});
