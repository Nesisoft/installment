import { describe, expect, it, vi } from 'vitest';
import { VerifyRunner } from './verify-runner';

const ACTOR = { actorId: 'verify', actorType: 'system' as const };

function make(stale: Array<{ id: string; schedule_id: string }>) {
  const findStaleUnresolved = vi.fn(async () => stale);
  const verifyAttempt = vi.fn();
  const runner = new VerifyRunner({ findStaleUnresolved } as never, { verifyAttempt } as never);
  return { runner, findStaleUnresolved, verifyAttempt };
}

describe('VerifyRunner.sweepStale', () => {
  it('re-verifies each stale attempt and tallies outcomes by status', async () => {
    const { runner, findStaleUnresolved, verifyAttempt } = make([
      { id: 'a1', schedule_id: 's1' },
      { id: 'a2', schedule_id: 's2' },
      { id: 'a3', schedule_id: 's3' },
      { id: 'a4', schedule_id: 's4' },
    ]);
    verifyAttempt
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce({ status: 'failed', failureReason: 'timeout_no_resolution' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'unknown' });

    const staleBefore = new Date('2026-10-15T12:00:00Z');
    const summary = await runner.sweepStale(staleBefore, ACTOR);

    expect(findStaleUnresolved).toHaveBeenCalledWith(staleBefore, undefined);
    expect(verifyAttempt).toHaveBeenCalledTimes(4);
    expect(verifyAttempt).toHaveBeenNthCalledWith(1, 'a1', ACTOR);
    expect(summary).toMatchObject({
      checked: 4,
      succeeded: 1,
      failed: 1,
      pending: 1,
      unknown: 1,
      skipped: 0,
    });
    expect(summary.outcomes[1]).toMatchObject({
      attemptId: 'a2',
      scheduleId: 's2',
      status: 'failed',
      reason: 'timeout_no_resolution',
    });
  });

  it('counts a thrown verify as skipped and keeps sweeping the rest', async () => {
    const { runner, verifyAttempt } = make([
      { id: 'a1', schedule_id: 's1' },
      { id: 'a2', schedule_id: 's2' },
    ]);
    verifyAttempt
      .mockRejectedValueOnce(new Error('paystack 500'))
      .mockResolvedValueOnce({ status: 'succeeded' });

    const summary = await runner.sweepStale(new Date(), ACTOR);

    expect(summary.checked).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'paystack 500' });
  });

  it('returns an empty summary when nothing is stale', async () => {
    const { runner, verifyAttempt } = make([]);
    const summary = await runner.sweepStale(new Date(), ACTOR);
    expect(summary.checked).toBe(0);
    expect(summary.outcomes).toHaveLength(0);
    expect(verifyAttempt).not.toHaveBeenCalled();
  });

  it('passes a custom limit through to the repository', async () => {
    const { runner, findStaleUnresolved } = make([]);
    await runner.sweepStale(new Date(), ACTOR, { limit: 50 });
    expect(findStaleUnresolved).toHaveBeenCalledWith(expect.any(Date), 50);
  });
});
