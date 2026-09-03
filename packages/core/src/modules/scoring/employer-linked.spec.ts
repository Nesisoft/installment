import { describe, expect, it } from 'vitest';
import { DEFAULT_STARTER_POLICY, ScoringEngine } from './scoring-engine';
import { DEFAULT_RULESET } from './ruleset';
import type { FeatureVector } from './types';

const NOW = new Date('2026-09-03T00:00:00.000Z');
const engine = new ScoringEngine();

/**
 * The employment tiers of the starter policy.
 *
 * The thin-file limit (#57) let the marketplace approve its own first customer,
 * at GHS 250 financed. An employer-linked first-timer then landed somewhere
 * worse than either extreme: `score.employer_linked` is worth up to 150 points,
 * enough to lift a newcomer over the 350 `unscorable` floor into `subprime` —
 * so the starter policy, which only fired on `declined`, no longer applied, and
 * the subprime branch sent them to `manual_review` instead. Being employed made
 * the decision slower.
 *
 * The totals below are this fixture's, which grants a known device and address
 * proof that real rows do not have yet; against Postgres the same two people
 * score 225 and 375. The floor they fall either side of is what matters, and it
 * is the same in both.
 *
 * These tests pin the graduation, and they are written as boundaries because
 * the interesting question about a credit ceiling is what it refuses.
 */

/** Day one: verified card, nothing borrowed, no employer. */
function newShopper(over: Partial<{ [K in keyof FeatureVector]: Partial<FeatureVector[K]> }> = {}) {
  const base: FeatureVector = {
    identity: {
      ghanaCardVerified: true,
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
    // Zero deposit, so orderAmountGhs IS the financed amount and each test
    // reads as the ceiling it is probing.
    request: {
      orderAmountGhs: 400,
      merchantCategory: 'electronics',
      planTemplateId: 'p1',
      planMinGhs: 50,
      planMaxGhs: 50_000,
      downPaymentBps: 0,
    },
  };
  const out = { ...base } as FeatureVector;
  for (const k of Object.keys(over) as (keyof FeatureVector)[]) {
    out[k] = { ...base[k], ...over[k] } as never;
  }
  return out;
}

const verifiedEmployer = { employerLinked: true, employerVerified: true };
const withPayroll = { ...verifiedEmployer, payrollDeductionConsent: true };

describe('employer-linked first-timers', () => {
  describe('the gap this closes', () => {
    it('used to send an employed newcomer to a human while an unemployed one sailed through', () => {
      // GHS 200 financed is inside the base tier, so both are approved and the
      // employed one is no worse off. The point of the fixture is the score
      // below it: the two people are on different sides of the subprime floor.
      const employed = engine.score(
        newShopper({ employment: withPayroll, request: { orderAmountGhs: 200 } }),
        NOW,
      );
      const unemployed = engine.score(newShopper({ request: { orderAmountGhs: 200 } }), NOW);

      expect(employed.outcome).toBe('approved');
      expect(unemployed.outcome).toBe('approved');
      expect(employed.score).toBeGreaterThan(unemployed.score);
      expect(employed.riskBand).toBe('subprime');
      expect(unemployed.riskBand).toBe('unscorable');
    });

    it('approves the order that used to need a human', () => {
      // GHS 600 financed is past the base GHS 250 and inside the GHS 750
      // employer tier. Before, this was manual_review.
      const d = engine.score(
        newShopper({ employment: verifiedEmployer, request: { orderAmountGhs: 600 } }),
        NOW,
      );

      expect(d.outcome).toBe('approved');
      expect(d.approvedLimitGhs).toBe(600);
    });
  });

  describe('the three tiers', () => {
    it('holds an unlinked shopper at the base ceiling', () => {
      expect(engine.score(newShopper({ request: { orderAmountGhs: 250 } }), NOW).outcome).toBe(
        'approved',
      );
      expect(engine.score(newShopper({ request: { orderAmountGhs: 251 } }), NOW).outcome).not.toBe(
        'approved',
      );
    });

    it('raises a verified employer link to the employer ceiling', () => {
      const at = engine.score(
        newShopper({ employment: verifiedEmployer, request: { orderAmountGhs: 750 } }),
        NOW,
      );
      const over = engine.score(
        newShopper({ employment: verifiedEmployer, request: { orderAmountGhs: 751 } }),
        NOW,
      );

      expect(at.outcome).toBe('approved');
      expect(over.outcome).not.toBe('approved');
    });

    it('raises payroll-deduction consent to the payroll ceiling', () => {
      const at = engine.score(
        newShopper({ employment: withPayroll, request: { orderAmountGhs: 2_000 } }),
        NOW,
      );
      const over = engine.score(
        newShopper({ employment: withPayroll, request: { orderAmountGhs: 2_001 } }),
        NOW,
      );

      expect(at.outcome).toBe('approved');
      expect(over.outcome).not.toBe('approved');
    });

    it('caps on what the plan finances, not what the order costs', () => {
      // GHS 1,000 at a 40% deposit finances GHS 600 — inside the GHS 750
      // employer tier even though the order is well past it. The deposit is
      // already ours, so it is not exposure.
      const d = engine.score(
        newShopper({
          employment: verifiedEmployer,
          request: { orderAmountGhs: 1_000, downPaymentBps: 4_000 },
        }),
        NOW,
      );

      expect(d.outcome).toBe('approved');
      expect(d.approvedLimitGhs).toBe(1_000);
    });

    /**
     * The boundary of this policy, pinned because it is not obvious.
     *
     * `limit` and `orderAmountGhs` are both measured on the ORDER, while the
     * starter ceiling is measured on what the plan FINANCES. When the order
     * clears the band limit but the financing is inside the ceiling, the engine
     * reaches the counter-offer branch first and the starter tiers never see
     * the request — a counter-offer is a live offer, not a refusal, so it is
     * left to stand rather than being overridden into a full approval.
     */
    it('leaves a counter-offer standing rather than upgrading it', () => {
      const d = engine.score(
        newShopper({
          employment: verifiedEmployer,
          request: { orderAmountGhs: 1_400, downPaymentBps: 5_000 },
        }),
        NOW,
      );

      expect(d.outcome).toBe('counter_offer');
      // And it never proposes financing MORE than the plan asked for: GHS 1,400
      // at 50% down finances 700, so 700 is the ceiling on the counter too.
      expect(d.counterOffer?.revisedAmountGhs).toBeLessThanOrEqual(700);
      expect(d.counterOffer?.downPaymentGhs).toBeGreaterThanOrEqual(700);
    });
  });

  describe('what the tier requires', () => {
    it('will not lift the ceiling for a link nobody verified', () => {
      // The whole reason `employerVerified` exists. An operator types an
      // employer and an employee number and the row lands `active` — that is
      // data entry, not evidence, and GHS 600 financed against it would be
      // lending on a typed field.
      const d = engine.score(
        newShopper({
          employment: { employerLinked: true, employerVerified: false },
          request: { orderAmountGhs: 600 },
        }),
        NOW,
      );

      expect(d.outcome).not.toBe('approved');
    });

    it('will not lift it for consent recorded against an unverified link', () => {
      // Consent to deduct from a salary at an employer nobody confirmed
      // collects nothing.
      const d = engine.score(
        newShopper({
          employment: {
            employerLinked: true,
            employerVerified: false,
            payrollDeductionConsent: true,
          },
          request: { orderAmountGhs: 1_500 },
        }),
        NOW,
      );

      expect(d.outcome).not.toBe('approved');
    });

    it('still requires a verified Ghana Card', () => {
      const d = engine.score(
        newShopper({
          identity: { ghanaCardVerified: false },
          employment: withPayroll,
          request: { orderAmountGhs: 600 },
        }),
        NOW,
      );

      expect(d.outcome).not.toBe('approved');
    });

    it('still refuses somebody carrying a default, however employed', () => {
      const d = engine.score(
        newShopper({
          repayment: { priorDefaultsAllTime: 1 },
          employment: withPayroll,
          request: { orderAmountGhs: 600 },
        }),
        NOW,
      );

      expect(d.outcome).not.toBe('approved');
    });

    it('still refuses somebody with an open plan — this is a FIRST order', () => {
      const d = engine.score(
        newShopper({
          exposure: { activePlansCount: 1, outstandingBalanceGhs: 300 },
          employment: withPayroll,
          request: { orderAmountGhs: 600 },
        }),
        NOW,
      );

      expect(d.outcome).not.toBe('approved');
    });
  });

  describe('policy configuration', () => {
    it('is switched off entirely by a zero base cap, employment or not', () => {
      // The base number is the master switch, as its documentation promises —
      // otherwise turning the policy off would silently leave the two
      // employment tiers lending.
      const off = new ScoringEngine(DEFAULT_RULESET, {
        ...DEFAULT_STARTER_POLICY,
        maxFinancedGhs: 0,
      });

      expect(off.score(newShopper({ employment: withPayroll }), NOW).outcome).not.toBe('approved');
    });

    it('never puts an employed customer below the base tier', () => {
      // A misconfiguration, not a decision: employment must not make somebody
      // worse off than having no employer at all.
      const upsideDown = new ScoringEngine(DEFAULT_RULESET, {
        maxFinancedGhs: 500,
        maxFinancedWithEmployerGhs: 100,
        maxFinancedWithPayrollGhs: 50,
      });

      expect(
        upsideDown.score(
          newShopper({ employment: withPayroll, request: { orderAmountGhs: 500 } }),
          NOW,
        ).outcome,
      ).toBe('approved');
    });

    it('leaves a customer the score already decides untouched', () => {
      const scored = newShopper({
        repayment: { completedPlansCount: 3, onTimePaymentRate: 1, consecutiveOnTime: 9 },
        tenure: { accountAgeDays: 400 },
        behavior: { successfulChargeCount: 40, momoTransactionShare: 0.5 },
        employment: withPayroll,
      });
      const tight = new ScoringEngine(DEFAULT_RULESET, {
        maxFinancedGhs: 1,
        maxFinancedWithEmployerGhs: 1,
        maxFinancedWithPayrollGhs: 1,
      });
      const loose = new ScoringEngine(DEFAULT_RULESET, {
        maxFinancedGhs: 100_000,
        maxFinancedWithEmployerGhs: 100_000,
        maxFinancedWithPayrollGhs: 100_000,
      });

      expect(tight.score(scored, NOW)).toEqual(loose.score(scored, NOW));
    });
  });

  describe('the decision stays readable', () => {
    it('reports the real band and score, not a flattering one', () => {
      // An analyst reading this has to see a deliberate appetite rather than a
      // creditworthy applicant: the score is still well below prime.
      const d = engine.score(
        newShopper({ employment: withPayroll, request: { orderAmountGhs: 1_500 } }),
        NOW,
      );

      expect(d.outcome).toBe('approved');
      expect(d.riskBand).toBe('subprime');
      expect(d.score).toBeLessThan(500);
    });

    it('approves the order rather than opening a line to spend against', () => {
      const d = engine.score(
        newShopper({ employment: withPayroll, request: { orderAmountGhs: 1_500 } }),
        NOW,
      );

      // Not the band limit — this order. A first-time customer has shown us
      // nothing that justifies a standing number.
      expect(d.approvedLimitGhs).toBe(1_500);
    });

    it('shows the employer-linkage rule that lifted the score', () => {
      const d = engine.score(newShopper({ employment: withPayroll }), NOW);
      const rule = d.rulesFired.find((r) => r.ruleId === 'score.employer_linked');

      expect(rule?.points).toBeGreaterThan(0);
    });
  });
});
