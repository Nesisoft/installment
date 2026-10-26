import { describe, expect, it, vi } from 'vitest';
import { AlternativeInstruments, isInstrumentFailure } from './alternative-instruments';

function deps(
  over: {
    last?: { payment_method: string | null } | undefined;
    customer?: Record<string, unknown>;
    card?: unknown;
  } = {},
) {
  const attempts = { findLatestForSchedule: vi.fn(async () => over.last) };
  const plans = {
    getInstallment: vi.fn(async () => ({ customer_plan_id: 'p1' })),
    get: vi.fn(async () => ({ customer_id: 'c1' })),
  };
  const customers = {
    get: vi.fn(
      async () => over.customer ?? { id: 'c1', momo_phone: '0244000000', momo_provider: 'mtn' },
    ),
  };
  const cards = { findUsable: vi.fn(async () => over.card ?? null) };
  const finder = new AlternativeInstruments(
    attempts as never,
    plans as never,
    customers as never,
    cards as never,
  );
  return { finder, attempts, cards };
}

describe('isInstrumentFailure', () => {
  it('knows a dead instrument from a blocked customer', () => {
    expect(isInstrumentFailure('Account Closed')).toBe(true);
    expect(isInstrumentFailure('invalid_account')).toBe(true);
    expect(isInstrumentFailure('Blocked Card')).toBe(true);
    // About the customer, not the instrument: nothing else should be tried.
    expect(isInstrumentFailure('Fraud Block')).toBe(false);
    expect(isInstrumentFailure('customer_blocked')).toBe(false);
    expect(isInstrumentFailure('Insufficient Funds')).toBe(false);
    expect(isInstrumentFailure(null)).toBe(false);
  });
});

describe('AlternativeInstruments.hasAnotherInstrument', () => {
  it('offers Mobile Money after a card, when a wallet is on file', async () => {
    const { finder, attempts } = deps({ last: { payment_method: 'card' } });
    expect(await finder.hasAnotherInstrument('s1')).toBe(true);
    // Only charges on a saved instrument count — not the customer's own link.
    expect(attempts.findLatestForSchedule).toHaveBeenCalledWith('s1', { channel: 'auto_debit' });
  });

  it('has nothing after a card when no wallet is on file', async () => {
    const { finder } = deps({
      last: { payment_method: 'card' },
      customer: { id: 'c1', momo_phone: null, momo_provider: null },
    });
    expect(await finder.hasAnotherInstrument('s1')).toBe(false);
  });

  it('offers the card after Mobile Money, only while it is usable', async () => {
    expect(
      await deps({
        last: { payment_method: 'momo' },
        card: { id: 'k1' },
      }).finder.hasAnotherInstrument('s1'),
    ).toBe(true);
    expect(
      await deps({ last: { payment_method: 'momo' }, card: null }).finder.hasAnotherInstrument(
        's1',
      ),
    ).toBe(false);
  });

  it('has nothing to say when no saved instrument was ever charged', async () => {
    expect(await deps({ last: undefined }).finder.hasAnotherInstrument('s1')).toBe(false);
  });
});
