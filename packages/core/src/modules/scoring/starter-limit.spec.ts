import { describe, expect, it } from 'vitest';
import { DEFAULT_STARTER_POLICY, ScoringEngine } from './scoring-engine';
import { DEFAULT_RULESET } from './ruleset';
import type { FeatureVector } from './types';

const NOW = new Date('2026-08-29T00:00:00.000Z');
const engine = new ScoringEngine();

/**
 * The thin-file starter limit.
 *
 * Every scoring rule that carries real weight needs a history to have points
 * about — on-time rate, consecutive payments, Paystack history, account age are
 * 450 of the available points and all zero on day one. A verified, blameless
 * first-time shopper therefore scored 275 against a 350 floor and was declined,
 * every time, which meant the marketplace could never approve its own first
 * customer. These tests are the policy that fixes that, and they are written as
 * boundaries because a credit rule is only as good as the edge it refuses at.
 */

/** Day one: verified, nothing against them, nothing for them either. */
function newShopper(over: Partial<{ [K in keyof FeatureVector]: Partial<FeatureVector[K]> }> = {}) {
  const base: FeatureVector = {
    identity: {
      ghanaCardVerified: true,
      // What IdentityCollector actually returns: a placeholder, not a signal.
      // The fixture says so on purpose — see the collector-backed integration
      // spec, which is what proves the policy fires against real rows.
      phoneVerified: false,
      phoneAgeDays: 400,
      addressProofUploaded: true,
      kycTier: 2,
      ageYears: 30,
    },
    repayment: {
      completedPlansCount: 0,
      onTimePaymentRate: 0,
      averageDaysPastDue: 0,
      priorDefaults12mo: 0,
      priorDefaultsAllTime: 0,
      consecutiveOnTime: 0,
    },
    behavior: {
      successfulChargeCount: 0,
      momoTransactionShare: 0,
      averageTransactionGhs: 0,
      failedChargeRate90d: 0,
    },
    tenure: {
      accountAgeDays: 0,
      loginsLast30Days: 1,
      deviceFingerprintKnown: true,
      distinctDevicesLast90Days: 1,
    },
    employment: {
      employerLinked: false,
      employerVerified: false,
      salaryBand: 'mid',
      employmentMonths: 0,
      payrollDeductionConsent: false,
    },
    exposure: {
      activePlansCount: 0,
      outstandingBalanceGhs: 0,
      currentLimitGhs: 0,
      applicationsLast24h: 0,
      isOnBlocklist: false,
    },
    // "Pay in 4": 40% deposit, so GHS 400 finances GHS 240.
    request: {
      orderAmountGhs: 400,
      merchantCategory: 'electronics',
      planTemplateId: 'p1',
      planMinGhs: 50,
      planMaxGhs: 5000,
      downPaymentBps: 4000,
    },
  };
  const out = { ...base } as FeatureVector;
  for (const k of Object.keys(over) as (keyof FeatureVector)[]) {
    out[k] = { ...base[k], ...over[k] } as never;
  }
  return out;
}

describe('thin-file starter limit', () => {
  it('approves a clean first-time shopper who was previously declined outright', () => {
    const d = engine.score(newShopper(), NOW);

    expect(d.outcome).toBe('approved');
    // The score is unchanged and still reported honestly: this is a policy
    // decision on top of a low score, not a fiddle that pretends the score is
    // higher than it is. An analyst reading the decision must see both.
    expect(d.score).toBe(275);
    expect(d.riskBand).toBe('unscorable');
  });

  it('approves this order rather than quoting a standing line of credit', () => {
    const d = engine.score(newShopper({ request: { orderAmountGhs: 300 } }), NOW);

    expect(d.approvedLimitGhs).toBe(300);
  });

  it('caps on what the plan finances, not on what the order costs', () => {
    // Same GHS 400 order. At 4000 bps it lends 240 and fits under the 250 cap;
    // at 0 bps it lends the whole 400 and does not. Capping the order amount
    // would have taken 67% more exposure on the zero-deposit template without
    // anyone choosing to.
    const withDeposit = engine.score(newShopper(), NOW);
    const noDeposit = engine.score(newShopper({ request: { downPaymentBps: 0 } }), NOW);

    expect(withDeposit.outcome).toBe('approved');
    expect(noDeposit.outcome).toBe('declined');
  });

  it('refuses a deposit that is not a number rather than letting NaN through', () => {
    // A malformed template must make the cap stricter, never unbounded: an
    // unguarded NaN comparison is false, which silently declines — but an
    // unguarded NaN *arithmetic* is the kind of thing that turns into an
    // approval when someone later flips the comparison around.
    const d = engine.score(
      newShopper({ request: { downPaymentBps: undefined as unknown as number } }),
      NOW,
    );

    expect(d.outcome).toBe('declined');
  });

  describe('the cap boundary', () => {
    // 4000 bps, so financed = order × 0.6. GHS 250 financed is a GHS 416.66 order.
    it('approves exactly at the cap', () => {
      const d = engine.score(
        newShopper({ request: { orderAmountGhs: DEFAULT_STARTER_POLICY.maxFinancedGhs / 0.6 } }),
        NOW,
      );
      expect(d.outcome).toBe('approved');
    });

    it('declines a cedi past it', () => {
      const d = engine.score(
        newShopper({
          request: { orderAmountGhs: DEFAULT_STARTER_POLICY.maxFinancedGhs / 0.6 + 1 },
        }),
        NOW,
      );
      expect(d.outcome).toBe('declined');
    });
  });

  describe('who it does not reach', () => {
    it('leaves the hard gates alone: an unverified Ghana Card still declines', () => {
      const d = engine.score(newShopper({ identity: { ghanaCardVerified: false } }), NOW);
      expect(d.outcome).toBe('declined');
      expect(d.score).toBe(0);
    });

    it('leaves the hard gates alone: a default in the last year still declines', () => {
      const d = engine.score(
        newShopper({ repayment: { priorDefaults12mo: 1, priorDefaultsAllTime: 1 } }),
        NOW,
      );
      expect(d.outcome).toBe('declined');
    });

    it('leaves the hard gates alone: a blocklisted customer still declines', () => {
      const d = engine.score(newShopper({ exposure: { isOnBlocklist: true } }), NOW);
      expect(d.outcome).toBe('declined');
    });

    it('leaves the exposure rules alone: an application burst still declines', () => {
      const d = engine.score(newShopper({ exposure: { applicationsLast24h: 9 } }), NOW);
      expect(d.outcome).toBe('declined');
    });

    /**
     * The twelve-month gate lets an older default through, and someone who
     * defaulted eighteen months ago and has completed nothing since looks
     * exactly like a newcomer to every other signal here. They are not one.
     */
    it('refuses an old default the twelve-month gate does not catch', () => {
      const d = engine.score(newShopper({ repayment: { priorDefaultsAllTime: 1 } }), NOW);
      expect(d.outcome).toBe('declined');
    });

    it('refuses someone already carrying a plan', () => {
      const d = engine.score(newShopper({ exposure: { activePlansCount: 1 } }), NOW);
      expect(d.outcome).toBe('declined');
    });

    it('refuses someone with an outstanding balance', () => {
      const d = engine.score(newShopper({ exposure: { outstandingBalanceGhs: 50 } }), NOW);
      expect(d.outcome).toBe('declined');
    });

    /**
     * A customer with a record is judged on the record. The starter limit is a
     * substitute for evidence, and once evidence exists the substitute would
     * only ever lower the bar.
     *
     * Note the outcome: not `declined`, but whatever their own repayment earns
     * them. Here a single completed plan with a perfect record clears the
     * subprime floor and is approved on its own merits — see the ladder specs.
     */
    it('does not apply to someone who has bought from us before', () => {
      const d = engine.score(
        newShopper({
          repayment: { completedPlansCount: 1, onTimePaymentRate: 1, consecutiveOnTime: 3 },
        }),
        NOW,
      );
      expect(d.outcome).not.toBe('approved');
      expect(d.score).toBeGreaterThan(275);
    });
  });

  /**
   * A policy where every tier is the same number. These tests use an unlinked
   * shopper, for whom only the base tier is reachable; flattening the three
   * keeps each case about the one number it is varying.
   */
  const flatPolicy = (maxFinancedGhs: number) => ({
    maxFinancedGhs,
    maxFinancedWithEmployerGhs: maxFinancedGhs,
    maxFinancedWithPayrollGhs: maxFinancedGhs,
  });

  describe('policy configuration', () => {
    it('is switched off entirely by a zero cap', () => {
      const off = new ScoringEngine(DEFAULT_RULESET, flatPolicy(0));
      expect(off.score(newShopper(), NOW).outcome).toBe('declined');
    });

    it('widens when the cap is raised', () => {
      const generous = new ScoringEngine(DEFAULT_RULESET, flatPolicy(2_000));
      const d = generous.score(newShopper({ request: { orderAmountGhs: 3_000 } }), NOW);
      expect(d.outcome).toBe('approved');
      expect(d.approvedLimitGhs).toBe(3_000);
    });

    it('does not touch a customer the score already decides', () => {
      // Someone with a real record reaches the normal path, and the starter
      // policy must be invisible to them however it is configured.
      const scored = newShopper({
        repayment: { completedPlansCount: 3, onTimePaymentRate: 1, consecutiveOnTime: 9 },
        tenure: { accountAgeDays: 400 },
        behavior: { successfulChargeCount: 40, momoTransactionShare: 0.5 },
      });
      const tight = new ScoringEngine(DEFAULT_RULESET, flatPolicy(1));
      const loose = new ScoringEngine(DEFAULT_RULESET, flatPolicy(100_000));

      expect(tight.score(scored, NOW)).toEqual(loose.score(scored, NOW));
    });
  });
});
