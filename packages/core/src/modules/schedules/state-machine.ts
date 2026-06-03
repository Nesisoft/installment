/**
 * Installment schedule lifecycle (ported from
 * docs/design/installment-schedule.state-machine.ts). Hand-rolled transition
 * table — pure data, easy to test and audit. Side effects live in the service
 * layer; this module only answers "what is the next state?".
 *
 *   pending ──due_date_reached──▶ due ──debit_initiated──▶ processing
 *   processing ──charge_succeeded──▶ paid ──refund_issued──▶ refunded
 *   processing ──charge_failed──▶ failed ──retryable──▶ retry_scheduled ──backoff_elapsed──▶ due
 *   failed ──{non_retryable_decline,grace_expired}──▶ overdue
 *   due ──unprocessed_past_grace──▶ overdue ──case_opened──▶ in_collections
 *   in_collections ──{payment_recovered▶paid, restructure_approved▶restructured, default_threshold_hit▶defaulted}
 *   {overdue,in_collections} ──admin_waive──▶ waived
 */
export type ScheduleStatus =
  | 'pending'
  | 'due'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'retry_scheduled'
  | 'overdue'
  | 'in_collections'
  | 'restructured'
  | 'defaulted'
  | 'waived'
  | 'refunded';

export type ScheduleEvent =
  | 'due_date_reached'
  | 'debit_initiated'
  | 'charge_succeeded'
  | 'charge_failed'
  | 'retryable'
  | 'non_retryable_decline'
  | 'backoff_elapsed'
  | 'grace_expired'
  | 'unprocessed_past_grace'
  | 'case_opened'
  | 'payment_recovered'
  | 'restructure_approved'
  | 'default_threshold_hit'
  | 'admin_waive'
  | 'refund_issued';

type Key = `${ScheduleStatus}:${ScheduleEvent}`;

const TRANSITIONS: Partial<Record<Key, ScheduleStatus>> = {
  // Happy path
  'pending:due_date_reached': 'due',
  'due:debit_initiated': 'processing',
  'processing:charge_succeeded': 'paid',

  // Failure & retry loop
  'processing:charge_failed': 'failed',
  'failed:retryable': 'retry_scheduled',
  'retry_scheduled:backoff_elapsed': 'due',

  // Escalation
  'failed:non_retryable_decline': 'overdue',
  'failed:grace_expired': 'overdue',
  'due:unprocessed_past_grace': 'overdue',
  'overdue:case_opened': 'in_collections',

  // Collections outcomes
  'in_collections:payment_recovered': 'paid',
  'in_collections:restructure_approved': 'restructured',
  'in_collections:default_threshold_hit': 'defaulted',

  // Admin overrides
  'overdue:admin_waive': 'waived',
  'in_collections:admin_waive': 'waived',
  'paid:refund_issued': 'refunded',
};

/** Terminal states never transition again (refunds leave from `paid`, which is not terminal). */
export const SCHEDULE_TERMINAL_STATES: ReadonlySet<ScheduleStatus> = new Set([
  'restructured',
  'defaulted',
  'waived',
  'refunded',
]);

export class IllegalScheduleTransitionError extends Error {
  constructor(from: ScheduleStatus, event: ScheduleEvent) {
    super(`Cannot apply event "${event}" to schedule in status "${from}"`);
    this.name = 'IllegalScheduleTransitionError';
  }
}

export class ScheduleTerminalStateError extends Error {
  constructor(state: ScheduleStatus) {
    super(`Schedule is in terminal state "${state}" and cannot transition`);
    this.name = 'ScheduleTerminalStateError';
  }
}

export function nextScheduleStatus(from: ScheduleStatus, event: ScheduleEvent): ScheduleStatus {
  if (SCHEDULE_TERMINAL_STATES.has(from)) throw new ScheduleTerminalStateError(from);
  const to = TRANSITIONS[`${from}:${event}`];
  if (!to) throw new IllegalScheduleTransitionError(from, event);
  return to;
}

export function canScheduleTransition(from: ScheduleStatus, event: ScheduleEvent): boolean {
  return !SCHEDULE_TERMINAL_STATES.has(from) && TRANSITIONS[`${from}:${event}`] !== undefined;
}
