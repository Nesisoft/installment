import { describe, expect, it } from 'vitest';
import type { BusinessModel } from '@installment/api-types';
import { DEFAULT_RISK_SUMMARY, defaultRiskSentence, sharesDefaultLoss } from './risk';

/**
 * The app's account of a default, checked against `DefaultService`.
 *
 * Every model draws the plan's reserve first; past it, BNPL bills Ejua's
 * default pool and hybrid and rent to own bill the merchant's payable
 * (`default.integration.spec.ts`: a rent to own default takes the payable from
 * 83,000 to −5,000). The app said Ejua carried the risk on every plan.
 */
describe('defaultRiskSentence', () => {
  it('says the seller shares the loss exactly where the engine bills them', () => {
    const models: BusinessModel[] = ['bnpl', 'layaway', 'hybrid', 'rent_to_own'];
    expect(models.filter(sharesDefaultLoss)).toEqual(['hybrid', 'rent_to_own']);
    for (const model of ['hybrid', 'rent_to_own'] as const) {
      expect(defaultRiskSentence(model)).toMatch(/comes off your future payouts/);
    }
  });

  it('never tells a hybrid or rent to own seller that Ejua carries the loss', () => {
    for (const model of ['hybrid', 'rent_to_own'] as const) {
      expect(defaultRiskSentence(model)).not.toMatch(/Ejua carries/);
    }
  });

  it('keeps what BNPL credited the seller theirs, past the reserve', () => {
    expect(defaultRiskSentence('bnpl')).toMatch(/reserve covers the loss first/);
    expect(defaultRiskSentence('bnpl')).toMatch(/stays yours/);
  });

  it('names the plan type the seller is sharing the risk on', () => {
    expect(defaultRiskSentence('rent_to_own')).toMatch(/Rent to own plans share/);
  });

  it('separates a late payment, which moves nothing, from a write-off', () => {
    for (const model of ['bnpl', 'hybrid', 'rent_to_own'] as const) {
      expect(defaultRiskSentence(model)).toMatch(/late payment takes nothing back/);
    }
    expect(DEFAULT_RISK_SUMMARY).toMatch(/hybrid and rent to own/);
  });
});
