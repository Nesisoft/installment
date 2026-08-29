import { describe, expect, it, vi } from 'vitest';
import { FeatureCollector } from './feature-collector';
import type { Collector } from './collectors/types';
import type { FeatureVector } from './types';

/** A collector that returns a fixed value and records that it was called. */
function ok<T>(value: T): Collector<T> {
  return { collect: vi.fn(async () => value), defaults: vi.fn(() => value) };
}

/** A collector whose collect() rejects; defaults() returns the fallback. */
function broken<T>(fallback: T): Collector<T> {
  return {
    collect: vi.fn(async () => {
      throw new Error('source down');
    }),
    defaults: vi.fn(() => fallback),
  };
}

const REQUEST: FeatureVector['request'] = {
  orderAmountGhs: 500,
  merchantCategory: 'electronics',
  planTemplateId: '33333333-3333-3333-3333-333333333333',
  planMinGhs: 10,
  planMaxGhs: 100_000,
  downPaymentBps: 4_000,
};

const identity: FeatureVector['identity'] = {
  ghanaCardVerified: true,
  phoneVerified: true,
  phoneAgeDays: 200,
  addressProofUploaded: true,
  kycTier: 2,
  ageYears: 30,
};
const repayment: FeatureVector['repayment'] = {
  completedPlansCount: 3,
  onTimePaymentRate: 1,
  averageDaysPastDue: 0,
  priorDefaults12mo: 0,
  priorDefaultsAllTime: 0,
  consecutiveOnTime: 6,
};
const behavior: FeatureVector['behavior'] = {
  successfulChargeCount: 20,
  momoTransactionShare: 0.5,
  averageTransactionGhs: 300,
  failedChargeRate90d: 0,
};
const tenure: FeatureVector['tenure'] = {
  accountAgeDays: 400,
  loginsLast30Days: 10,
  deviceFingerprintKnown: true,
  distinctDevicesLast90Days: 1,
};
const employment: FeatureVector['employment'] = {
  employerLinked: true,
  salaryBand: 'mid',
  employmentMonths: 24,
  payrollDeductionConsent: true,
};
const exposure: FeatureVector['exposure'] = {
  activePlansCount: 0,
  outstandingBalanceGhs: 0,
  currentLimitGhs: 5000,
  applicationsLast24h: 1,
  isOnBlocklist: false,
};

describe('FeatureCollector', () => {
  it('assembles every slice plus the caller-supplied request', async () => {
    const fc = new FeatureCollector(
      ok(identity),
      ok(repayment),
      ok(behavior),
      ok(tenure),
      ok(employment),
      ok(exposure),
    );

    const v = await fc.collect('cust-1', REQUEST);

    expect(v).toEqual({
      identity,
      repayment,
      behavior,
      tenure,
      employment,
      exposure,
      request: REQUEST,
    });
  });

  it('passes the customer id to each collector', async () => {
    const id = ok(identity);
    const fc = new FeatureCollector(
      id,
      ok(repayment),
      ok(behavior),
      ok(tenure),
      ok(employment),
      ok(exposure),
    );

    await fc.collect('cust-42', REQUEST);

    expect(id.collect).toHaveBeenCalledWith('cust-42');
  });

  it('falls back to defaults() when a single collector throws', async () => {
    const brokenExposure = broken(exposure);
    const fc = new FeatureCollector(
      ok(identity),
      ok(repayment),
      ok(behavior),
      ok(tenure),
      ok(employment),
      brokenExposure,
    );

    const v = await fc.collect('cust-1', REQUEST);

    expect(brokenExposure.defaults).toHaveBeenCalledOnce();
    expect(v.exposure).toEqual(exposure);
    // Healthy slices are unaffected.
    expect(v.identity).toEqual(identity);
  });

  it('survives every collector failing at once', async () => {
    const fc = new FeatureCollector(
      broken(identity),
      broken(repayment),
      broken(behavior),
      broken(tenure),
      broken(employment),
      broken(exposure),
    );

    const v = await fc.collect('cust-1', REQUEST);

    expect(v).toEqual({
      identity,
      repayment,
      behavior,
      tenure,
      employment,
      exposure,
      request: REQUEST,
    });
  });
});
