import { describe, expect, it } from 'vitest';
import { InMemoryTelcoHealthStore, TelcoHealthMonitor } from './telco-health';

function monitor(opts = {}) {
  return new TelcoHealthMonitor(new InMemoryTelcoHealthStore(), {
    windowMs: 60_000,
    minAttempts: 10,
    degradedBelow: 0.7,
    downBelow: 0.3,
    ...opts,
  });
}

async function feed(m: TelcoHealthMonitor, successes: number, failures: number, at = new Date()) {
  for (let i = 0; i < successes; i++) await m.recordOutcome('mtn', true, at);
  for (let i = 0; i < failures; i++) await m.recordOutcome('mtn', false, at);
}

describe('TelcoHealthMonitor', () => {
  it('is unknown below the minimum attempt count', async () => {
    const m = monitor();
    await feed(m, 4, 1); // 5 < minAttempts 10
    const h = await m.health('mtn');
    expect(h.status).toBe('unknown');
    expect(h.attempts).toBe(5);
    expect(h.successRate).toBeCloseTo(0.8);
  });

  it('is healthy at/above the degraded threshold', async () => {
    const m = monitor();
    await feed(m, 8, 2); // 80%
    expect((await m.health('mtn')).status).toBe('healthy');
  });

  it('is degraded between the down and degraded thresholds', async () => {
    const m = monitor();
    await feed(m, 5, 5); // 50% → < 0.7 but ≥ 0.3
    const h = await m.health('mtn');
    expect(h.status).toBe('degraded');
    expect(h.successRate).toBeCloseTo(0.5);
  });

  it('is down below the down threshold', async () => {
    const m = monitor();
    await feed(m, 2, 8); // 20%
    expect((await m.health('mtn')).status).toBe('down');
  });

  it('ignores outcomes outside the rolling window', async () => {
    const m = monitor({ windowMs: 60_000 });
    const now = new Date('2026-10-15T12:00:00Z');
    // 10 failures two minutes ago (outside the 1-min window) …
    await feed(m, 0, 10, new Date(now.getTime() - 2 * 60_000));
    // … and 10 successes just now.
    await feed(m, 10, 0, now);
    const h = await m.health('mtn', now);
    expect(h.attempts).toBe(10);
    expect(h.status).toBe('healthy');
  });

  it('snapshot reports every telco (unknown when no data)', async () => {
    const m = monitor();
    await feed(m, 10, 0);
    const snap = await m.snapshot();
    expect(snap.map((s) => s.telco).sort()).toEqual(['mtn', 'tgo', 'vod']);
    expect(snap.find((s) => s.telco === 'mtn')!.status).toBe('healthy');
    expect(snap.find((s) => s.telco === 'tgo')!.status).toBe('unknown');
    expect(snap.find((s) => s.telco === 'vod')!.successRate).toBeNull();
  });
});
