import { type Database } from '@installment/db';
import type { FeatureVector } from './types';
import type {
  Collector,
  IdentitySignals,
  RepaymentSignals,
  BehaviorSignals,
  TenureSignals,
  EmploymentSignals,
  ExposureSignals,
} from './collectors/types';
import { IdentityCollector } from './collectors/identity.collector';
import { RepaymentCollector } from './collectors/repayment.collector';
import { BehaviorCollector } from './collectors/behavior.collector';
import { TenureCollector } from './collectors/tenure.collector';
import { EmploymentCollector } from './collectors/employment.collector';
import { ExposureCollector } from './collectors/exposure.collector';

/**
 * Assembles a {@link FeatureVector} by running the six signal collectors in
 * parallel. Each collector is fail-soft: if it throws, its `defaults()` are
 * substituted, so one degraded data source degrades the score rather than
 * failing the whole decision. The `request` slice is supplied by the caller
 * (it comes from the application + plan template, not a collector).
 */
export class FeatureCollector {
  constructor(
    private readonly identity: Collector<IdentitySignals>,
    private readonly repayment: Collector<RepaymentSignals>,
    private readonly behavior: Collector<BehaviorSignals>,
    private readonly tenure: Collector<TenureSignals>,
    private readonly employment: Collector<EmploymentSignals>,
    private readonly exposure: Collector<ExposureSignals>,
  ) {}

  /** Wires the production collectors against a live database. */
  static fromDb(db: Database): FeatureCollector {
    return new FeatureCollector(
      new IdentityCollector(db),
      new RepaymentCollector(db),
      new BehaviorCollector(db),
      new TenureCollector(db),
      new EmploymentCollector(db),
      new ExposureCollector(db),
    );
  }

  async collect(customerId: string, request: FeatureVector['request']): Promise<FeatureVector> {
    const [identity, repayment, behavior, tenure, employment, exposure] = await Promise.all([
      this.safe(this.identity, customerId),
      this.safe(this.repayment, customerId),
      this.safe(this.behavior, customerId),
      this.safe(this.tenure, customerId),
      this.safe(this.employment, customerId),
      this.safe(this.exposure, customerId),
    ]);
    return { identity, repayment, behavior, tenure, employment, exposure, request };
  }

  private safe<T>(collector: Collector<T>, customerId: string): Promise<T> {
    return collector.collect(customerId).catch(() => collector.defaults());
  }
}
