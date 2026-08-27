import { describe, expect, it, vi } from 'vitest';
import { DebitRunner } from './debit-runner';

const ACTOR = { actorId: 'sys', actorType: 'system' as const };

function deps(
  over: {
    installment?: Record<string, unknown>;
    plan?: Record<string, unknown>;
    customer?: Record<string, unknown>;
    chargeResult?: { status: string; providerReference?: string; failureReason?: string };
    chargeThrows?: Error;
    due?: Array<{ id: string }>;
    card?: { authorization_code: string } | null;
    cardResult?: { status: string; providerReference?: string; failureReason?: string };
    cardThrows?: Error;
  } = {},
) {
  const installment = over.installment ?? { id: 's1', customer_plan_id: 'p1' };
  const plan = over.plan ?? { id: 'p1', customer_id: 'c1' };
  const customer = over.customer ?? {
    id: 'c1',
    email: 'a@x.gh',
    momo_phone: '0240000000',
    momo_provider: 'mtn',
  };
  const chargeMobileMoney = vi.fn(async () => {
    if (over.chargeThrows) throw over.chargeThrows;
    return over.chargeResult ?? { status: 'pending', providerReference: 'ref-1' };
  });
  const plans = {
    getInstallment: vi.fn(async () => installment),
    get: vi.fn(async () => plan),
    listDueForAutoDebit: vi.fn(async () => over.due ?? []),
  };
  const customers = { get: vi.fn(async () => customer) };
  const chargeCard = vi.fn(async () => {
    if (over.cardThrows) throw over.cardThrows;
    return over.cardResult ?? { status: 'succeeded', providerReference: 'card-ref' };
  });
  // Undefined `card` means no card service at all — the pre-card behaviour.
  const cards = over.card === undefined ? undefined : { findUsable: vi.fn(async () => over.card) };
  const runner = new DebitRunner(
    plans as never,
    customers as never,
    { chargeMobileMoney, chargeCard } as never,
    cards as never,
  );
  return { runner, plans, customers, chargeMobileMoney, chargeCard, cards };
}

describe('DebitRunner.attemptAutoDebit', () => {
  it('charges the saved MoMo instrument and maps the charge result', async () => {
    const { runner, chargeMobileMoney } = deps({
      chargeResult: { status: 'succeeded', providerReference: 'ps-9' },
    });

    const outcome = await runner.attemptAutoDebit('s1', ACTOR);

    expect(chargeMobileMoney).toHaveBeenCalledWith(
      { scheduleId: 's1', email: 'a@x.gh', phone: '0240000000', provider: 'mtn' },
      ACTOR,
    );
    expect(outcome).toEqual({
      scheduleId: 's1',
      status: 'succeeded',
      providerReference: 'ps-9',
      reason: undefined,
    });
  });

  it('skips a customer with no MoMo on file (never charges)', async () => {
    const { runner, chargeMobileMoney } = deps({
      customer: { id: 'c1', email: 'a@x.gh', momo_phone: null, momo_provider: null },
    });

    const outcome = await runner.attemptAutoDebit('s1', ACTOR);

    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('no_instrument');
    expect(chargeMobileMoney).not.toHaveBeenCalled();
  });

  /**
   * The reason this feature exists: a card authorization debits silently, while
   * a Mobile Money charge sends a prompt the customer has to notice and approve.
   * Reaching for MoMo when a card is on file turns a collection into a request.
   */
  it('prefers a saved card over Mobile Money', async () => {
    const { runner, chargeCard, chargeMobileMoney } = deps({
      card: { authorization_code: 'AUTH_abc' },
      cardResult: { status: 'succeeded', providerReference: 'card-9' },
    });

    const outcome = await runner.attemptAutoDebit('s1', ACTOR);

    expect(outcome.status).toBe('succeeded');
    expect(outcome.providerReference).toBe('card-9');
    expect(chargeCard).toHaveBeenCalledWith(
      { scheduleId: 's1', email: 'a@x.gh', authorizationCode: 'AUTH_abc' },
      ACTOR,
    );
    // The customer has MoMo on file too; it must not also be charged.
    expect(chargeMobileMoney).not.toHaveBeenCalled();
  });

  it('falls back to Mobile Money when there is no usable card', async () => {
    const { runner, chargeCard, chargeMobileMoney } = deps({ card: null });

    const outcome = await runner.attemptAutoDebit('s1', ACTOR);

    expect(chargeCard).not.toHaveBeenCalled();
    expect(chargeMobileMoney).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('pending');
  });

  /**
   * One instrument per run. Cascading to MoMo after a card failure is how a
   * charge that actually succeeded but reported a failure becomes two debits —
   * the retry ladder is what tries again, with the unresolved-attempt guard in
   * between.
   */
  it('does not fall back to Mobile Money after a failed card charge', async () => {
    const { runner, chargeMobileMoney } = deps({
      card: { authorization_code: 'AUTH_abc' },
      cardResult: { status: 'failed', failureReason: 'insufficient_funds' },
    });

    const outcome = await runner.attemptAutoDebit('s1', ACTOR);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('insufficient_funds');
    expect(chargeMobileMoney).not.toHaveBeenCalled();
  });

  it('still charges Mobile Money when no card service is wired at all', async () => {
    // Framework-free callers construct DebitRunner without one; collection must
    // behave exactly as it did before cards existed.
    const { runner, chargeMobileMoney } = deps();

    await runner.attemptAutoDebit('s1', ACTOR);

    expect(chargeMobileMoney).toHaveBeenCalledOnce();
  });

  it('skips an unsupported provider', async () => {
    const { runner, chargeMobileMoney } = deps({
      customer: { id: 'c1', email: 'a@x.gh', momo_phone: '024', momo_provider: 'airtel' },
    });
    const outcome = await runner.attemptAutoDebit('s1', ACTOR);
    expect(outcome.status).toBe('skipped');
    expect(chargeMobileMoney).not.toHaveBeenCalled();
  });

  it('turns a thrown charge (e.g. lost the race to another worker) into a skip', async () => {
    const { runner } = deps({ chargeThrows: new Error('illegal transition') });
    const outcome = await runner.attemptAutoDebit('s1', ACTOR);
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('illegal transition');
  });

  it('skips when the lookup fails (e.g. schedule not found)', async () => {
    const { runner, plans } = deps();
    plans.getInstallment.mockRejectedValueOnce(new Error('not found'));
    const outcome = await runner.attemptAutoDebit('missing', ACTOR);
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('not found');
  });
});

describe('DebitRunner.sweepDue', () => {
  it('attempts every due installment and tallies outcomes by status', async () => {
    const { runner, plans, chargeMobileMoney } = deps({
      due: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });
    // s1 succeeds, s2 pending, s3 fails.
    chargeMobileMoney
      .mockResolvedValueOnce({ status: 'succeeded', providerReference: 'r1' } as never)
      .mockResolvedValueOnce({ status: 'pending', providerReference: 'r2' } as never)
      .mockResolvedValueOnce({ status: 'failed', failureReason: 'insufficient' } as never);

    const summary = await runner.sweepDue(new Date('2026-10-15T00:00:00Z'), ACTOR);

    expect(plans.listDueForAutoDebit).toHaveBeenCalledOnce();
    expect(summary.asOfDate).toBe('2026-10-15');
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes).toHaveLength(3);
  });

  it('counts a no-instrument customer as skipped within the sweep', async () => {
    const { runner } = deps({
      due: [{ id: 's1' }],
      customer: { id: 'c1', email: 'a@x.gh', momo_phone: null, momo_provider: null },
    });
    const summary = await runner.sweepDue(new Date(), ACTOR);
    expect(summary.attempted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.succeeded).toBe(0);
  });
});
