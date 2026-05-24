import type { FeatureVector } from '../types';

/**
 * A signal collector reads one slice of the {@link FeatureVector} from a data
 * source. Collectors are independent and fail-soft: the orchestrator calls
 * collect() and falls back to defaults() if it throws, so one degraded source
 * never fails the whole decision (DEVELOPMENT-PLAN.md §4: "one source down ≠
 * outage").
 */
export interface Collector<T> {
  collect(customerId: string): Promise<T>;
  /** Neutral fallback used when collect() throws. */
  defaults(): T;
}

export type IdentitySignals = FeatureVector['identity'];
export type RepaymentSignals = FeatureVector['repayment'];
export type BehaviorSignals = FeatureVector['behavior'];
export type TenureSignals = FeatureVector['tenure'];
export type EmploymentSignals = FeatureVector['employment'];
export type ExposureSignals = FeatureVector['exposure'];
