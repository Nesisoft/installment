/**
 * Telco (Mobile Money network) health monitor. Tracks per-network charge
 * success over a rolling window so the system can flag a degraded MNO — e.g.
 * "MTN MoMo is failing 60% of charges right now" — and alert / route around it.
 *
 * The store is a pluggable port (Redis in production, in-memory in tests). The
 * monitor itself is pure policy: thresholds + status classification.
 */
export type Telco = 'mtn' | 'tgo' | 'vod';

export const TELCOS: readonly Telco[] = ['mtn', 'tgo', 'vod'];

export type TelcoStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface TelcoCounts {
  success: number;
  failure: number;
}

/** Storage for time-stamped charge outcomes, windowed on read. */
export interface TelcoHealthStore {
  record(telco: Telco, success: boolean, at: Date): Promise<void>;
  /** Success/failure counts for `telco` with outcomes at or after `since`. */
  counts(telco: Telco, since: Date): Promise<TelcoCounts>;
}

export interface TelcoHealth {
  telco: Telco;
  attempts: number;
  successes: number;
  failures: number;
  /** 0..1, or null when there are too few attempts to judge. */
  successRate: number | null;
  status: TelcoStatus;
}

export interface TelcoHealthOptions {
  /** Rolling window length. Default 15 minutes. */
  windowMs?: number;
  /** Below this many attempts in the window, status is `unknown`. Default 10. */
  minAttempts?: number;
  /** Success rate below this → `degraded`. Default 0.70. */
  degradedBelow?: number;
  /** Success rate below this → `down`. Default 0.30. */
  downBelow?: number;
}

const DEFAULTS: Required<TelcoHealthOptions> = {
  windowMs: 15 * 60_000,
  minAttempts: 10,
  degradedBelow: 0.7,
  downBelow: 0.3,
};

export class TelcoHealthMonitor {
  private readonly opts: Required<TelcoHealthOptions>;

  constructor(
    private readonly store: TelcoHealthStore,
    opts: TelcoHealthOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Records one charge outcome. Best-effort callers should swallow rejections. */
  async recordOutcome(telco: Telco, success: boolean, at: Date = new Date()): Promise<void> {
    await this.store.record(telco, success, at);
  }

  /** Health of one telco as of `now`. */
  async health(telco: Telco, now: Date = new Date()): Promise<TelcoHealth> {
    const since = new Date(now.getTime() - this.opts.windowMs);
    const { success, failure } = await this.store.counts(telco, since);
    const attempts = success + failure;

    if (attempts < this.opts.minAttempts) {
      return {
        telco,
        attempts,
        successes: success,
        failures: failure,
        successRate: attempts === 0 ? null : success / attempts,
        status: 'unknown',
      };
    }

    const rate = success / attempts;
    const status: TelcoStatus =
      rate < this.opts.downBelow ? 'down' : rate < this.opts.degradedBelow ? 'degraded' : 'healthy';

    return { telco, attempts, successes: success, failures: failure, successRate: rate, status };
  }

  /** Health of every telco as of `now`. */
  async snapshot(now: Date = new Date()): Promise<TelcoHealth[]> {
    return Promise.all(TELCOS.map((t) => this.health(t, now)));
  }
}

/**
 * In-memory {@link TelcoHealthStore} for tests and single-process dev. Keeps a
 * flat list of timestamped outcomes per telco and prunes on read.
 */
export class InMemoryTelcoHealthStore implements TelcoHealthStore {
  private readonly events = new Map<Telco, Array<{ at: number; success: boolean }>>();

  async record(telco: Telco, success: boolean, at: Date): Promise<void> {
    const list = this.events.get(telco) ?? [];
    list.push({ at: at.getTime(), success });
    this.events.set(telco, list);
  }

  async counts(telco: Telco, since: Date): Promise<TelcoCounts> {
    const cutoff = since.getTime();
    const list = (this.events.get(telco) ?? []).filter((e) => e.at >= cutoff);
    this.events.set(telco, list); // prune
    return {
      success: list.filter((e) => e.success).length,
      failure: list.filter((e) => !e.success).length,
    };
  }
}
