import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * The process's one Prometheus registry, served by `GET /metrics`.
 *
 * Module-level, like `captureAlert`, so a cron can record a run with one call
 * and no constructor change — the scheduled jobs are the thing ops most needs
 * to see, and threading a service through each of them would touch every
 * spec that builds one.
 */
export const metricsRegistry = new Registry();

// Node's own: event-loop lag, heap, GC, CPU, open handles.
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP requests by method, route pattern and status, and how long they took.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const jobRuns = new Counter({
  name: 'installment_job_runs_total',
  help: 'Scheduled job runs, by job and whether the run threw.',
  labelNames: ['job', 'outcome'] as const,
  registers: [metricsRegistry],
});

const jobLastRun = new Gauge({
  name: 'installment_job_last_run_timestamp_seconds',
  help: 'When each scheduled job last ran, successfully or not (unix seconds).',
  labelNames: ['job'] as const,
  registers: [metricsRegistry],
});

const jobLastSuccess = new Gauge({
  name: 'installment_job_last_success_timestamp_seconds',
  help: 'When each scheduled job last ran without throwing (unix seconds).',
  labelNames: ['job'] as const,
  registers: [metricsRegistry],
});

/**
 * Records one run of a scheduled job. `failure` means the run threw — a job
 * that ran and found problems (a payout refused, a refund unresolved) is a
 * success here; those raise their own alerts and gauges.
 */
export function recordJobRun(job: string, outcome: 'success' | 'failure', at = new Date()): void {
  const seconds = at.getTime() / 1000;
  jobRuns.inc({ job, outcome });
  jobLastRun.set({ job }, seconds);
  if (outcome === 'success') jobLastSuccess.set({ job }, seconds);
}

export const ledgerHealthy = new Gauge({
  name: 'installment_ledger_healthy',
  help: '1 when the last hourly ledger integrity check passed, 0 when it failed.',
  registers: [metricsRegistry],
});

export const ledgerUnbalancedTransactions = new Gauge({
  name: 'installment_ledger_unbalanced_transactions',
  help: 'Ledger transactions whose debits and credits differ, at the last check.',
  registers: [metricsRegistry],
});

// An unlabelled gauge starts at 0, and a 0 here means "the ledger is out of
// balance". Until this process has run the check there is no answer, so
// publish no sample rather than a failure: a restart, or a replica that does
// not run the scheduled jobs, must not page anyone.
ledgerHealthy.remove();
ledgerUnbalancedTransactions.remove();
