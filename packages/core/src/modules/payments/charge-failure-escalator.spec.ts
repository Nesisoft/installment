import { describe, expect, it, vi } from 'vitest';
import { ChargeFailureEscalator } from './charge-failure-escalator';

const ACTOR = { actorId: '00000000-0000-0000-0000-000000000000', actorType: 'system' as const };

function deps(over: { another?: boolean | Error; attemptCount?: number } = {}) {
  const plans = {
    getInstallment: vi.fn(async () => ({
      amount_due_pesewas: 25_000,
      late_fee_pesewas: 0,
      attempt_count: over.attemptCount ?? 1,
    })),
  };
  const events: string[] = [];
  const schedules = {
    applyEvent: vi.fn(async (_id: string, event: string) => void events.push(event)),
  };
  const retryScheduler = { scheduleRetry: vi.fn(async () => undefined) };
  const alternatives =
    over.another === undefined
      ? undefined
      : {
          hasAnotherInstrument: vi.fn(async () => {
            if (over.another instanceof Error) throw over.another;
            return over.another as boolean;
          }),
        };
  const escalator = new ChargeFailureEscalator(
    plans as never,
    schedules as never,
    retryScheduler as never,
    undefined,
    alternatives,
  );
  return { escalator, events, retryScheduler, alternatives };
}

describe('ChargeFailureEscalator — a decline that rules out one instrument', () => {
  it('keeps the ladder going when another instrument is on file', async () => {
    // A stale wallet tried after a declined card: "Account Closed" says
    // nothing about the card, which is still there to be tried.
    const { escalator, events, retryScheduler } = deps({ another: true });
    await escalator.apply('s1', 'Account Closed', ACTOR);
    expect(events).toEqual(['charge_failed', 'retryable']);
    expect(retryScheduler.scheduleRetry).toHaveBeenCalledOnce();
  });

  it('is final when there is nothing else to try', async () => {
    const { escalator, events, retryScheduler } = deps({ another: false });
    await escalator.apply('s1', 'Account Closed', ACTOR);
    expect(events).toEqual(['charge_failed', 'non_retryable_decline']);
    expect(retryScheduler.scheduleRetry).not.toHaveBeenCalled();
  });

  it('is final for a decline about the customer, whatever is on file', async () => {
    const { escalator, events, alternatives } = deps({ another: true });
    await escalator.apply('s1', 'Fraud Block', ACTOR);
    expect(events).toEqual(['charge_failed', 'non_retryable_decline']);
    expect(alternatives!.hasAnotherInstrument).not.toHaveBeenCalled();
  });

  it('stays final when the lookup fails, or is not wired', async () => {
    for (const d of [deps({ another: new Error('db down') }), deps()]) {
      await d.escalator.apply('s1', 'Blocked Card', ACTOR);
      expect(d.events).toEqual(['charge_failed', 'non_retryable_decline']);
    }
  });

  it('still runs out at the end of the ladder', async () => {
    // Four attempts used: nothing left to schedule, so the row stays failed
    // for the grace-expiry sweep, as any exhausted retryable decline does.
    const { escalator, events, retryScheduler } = deps({ another: true, attemptCount: 4 });
    await escalator.apply('s1', 'Account Closed', ACTOR);
    expect(events).toEqual(['charge_failed']);
    expect(retryScheduler.scheduleRetry).not.toHaveBeenCalled();
  });
});
