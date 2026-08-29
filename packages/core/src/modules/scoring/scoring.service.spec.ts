import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@installment/db';
import { ScoringService } from './scoring.service';
import { ScoringEngine } from './scoring-engine';
import { FeatureCollector } from './feature-collector';
import type { Collector } from './collectors/types';
import type { FeatureVector } from './types';
import type { Application, ApplicationsService } from '../applications/applications.service';

function fixed<T>(value: T): Collector<T> {
  return { collect: vi.fn(async () => value), defaults: () => value };
}

const SLICES = {
  identity: {
    ghanaCardVerified: false,
    phoneVerified: false,
    phoneAgeDays: 0,
    addressProofUploaded: false,
    kycTier: 0,
    ageYears: 30,
  } as FeatureVector['identity'],
  repayment: {
    completedPlansCount: 0,
    onTimePaymentRate: 1,
    averageDaysPastDue: 0,
    priorDefaults12mo: 0,
    priorDefaultsAllTime: 0,
    consecutiveOnTime: 0,
  } as FeatureVector['repayment'],
  behavior: {
    paystackTransactionCount: 0,
    momoTransactionShare: 0,
    averageTransactionGhs: 0,
    failedChargeRate90d: 0,
  } as FeatureVector['behavior'],
  tenure: {
    accountAgeDays: 0,
    loginsLast30Days: 0,
    deviceFingerprintKnown: false,
    distinctDevicesLast90Days: 0,
  } as FeatureVector['tenure'],
  employment: {
    employerLinked: false,
    salaryBand: 'unknown',
    employmentMonths: null,
    payrollDeductionConsent: false,
  } as FeatureVector['employment'],
  exposure: {
    activePlansCount: 0,
    outstandingBalanceGhs: 0,
    currentLimitGhs: 0,
    applicationsLast24h: 0,
    isOnBlocklist: false,
  } as FeatureVector['exposure'],
};

function fakeCollector(): FeatureCollector {
  return new FeatureCollector(
    fixed(SLICES.identity),
    fixed(SLICES.repayment),
    fixed(SLICES.behavior),
    fixed(SLICES.tenure),
    fixed(SLICES.employment),
    fixed(SLICES.exposure),
  );
}

const APP = {
  id: 'app-1',
  customer_id: 'cust-1',
  plan_template_id: 'plan-1',
  order_amount_pesewas: 500_000,
  merchant_category: 'electronics',
  status: 'pending',
} as unknown as Application;

describe('ScoringService.dryRun', () => {
  it('builds the request from the application + plan and never persists', async () => {
    const insert = vi.fn();
    const transaction = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ min: 1_000, max: 1_000_000, downPaymentBps: 4_000 }],
          }),
        }),
      }),
      insert,
      transaction,
    } as unknown as Database;
    const applications = { get: vi.fn(async () => APP) } as unknown as ApplicationsService;

    const svc = new ScoringService(db, fakeCollector(), new ScoringEngine(), applications);
    const decision = await svc.dryRun('app-1');

    expect(decision.featuresSnapshot.request).toEqual({
      orderAmountGhs: 5_000,
      merchantCategory: 'electronics',
      planTemplateId: 'plan-1',
      planMinGhs: 10,
      planMaxGhs: 10_000,
      downPaymentBps: 4_000,
    });
    expect(decision.outcome).toBe('declined'); // unverified Ghana Card gates out
    expect(insert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('ScoringService.scoreFeatures', () => {
  it('delegates to the engine', () => {
    const svc = new ScoringService(
      {} as unknown as Database,
      fakeCollector(),
      new ScoringEngine(),
      {} as unknown as ApplicationsService,
    );
    const features: FeatureVector = {
      ...SLICES,
      request: {
        orderAmountGhs: 500,
        merchantCategory: 'electronics',
        planTemplateId: 'plan-1',
        planMinGhs: 10,
        planMaxGhs: 10_000,
        downPaymentBps: 4_000,
      },
    };
    const decision = svc.scoreFeatures(features);
    expect(decision.outcome).toBe('declined');
    expect(decision.score).toBe(0);
  });
});
