import { describe, expect, it } from 'vitest';
import {
  IllegalScheduleTransitionError,
  SCHEDULE_TERMINAL_STATES,
  ScheduleTerminalStateError,
  canScheduleTransition,
  nextScheduleStatus,
} from './state-machine';

describe('nextScheduleStatus', () => {
  it('walks the happy path pending → due → processing → paid', () => {
    expect(nextScheduleStatus('pending', 'due_date_reached')).toBe('due');
    expect(nextScheduleStatus('due', 'debit_initiated')).toBe('processing');
    expect(nextScheduleStatus('processing', 'charge_succeeded')).toBe('paid');
  });

  it('loops through the retry path', () => {
    expect(nextScheduleStatus('processing', 'charge_failed')).toBe('failed');
    expect(nextScheduleStatus('failed', 'retryable')).toBe('retry_scheduled');
    expect(nextScheduleStatus('retry_scheduled', 'backoff_elapsed')).toBe('due');
  });

  it('escalates to overdue then collections', () => {
    expect(nextScheduleStatus('failed', 'non_retryable_decline')).toBe('overdue');
    expect(nextScheduleStatus('failed', 'grace_expired')).toBe('overdue');
    expect(nextScheduleStatus('due', 'unprocessed_past_grace')).toBe('overdue');
    expect(nextScheduleStatus('overdue', 'case_opened')).toBe('in_collections');
  });

  it('resolves collections cases', () => {
    expect(nextScheduleStatus('in_collections', 'payment_recovered')).toBe('paid');
    expect(nextScheduleStatus('in_collections', 'restructure_approved')).toBe('restructured');
    expect(nextScheduleStatus('in_collections', 'default_threshold_hit')).toBe('defaulted');
  });

  it('handles admin overrides and refunds', () => {
    expect(nextScheduleStatus('overdue', 'admin_waive')).toBe('waived');
    expect(nextScheduleStatus('in_collections', 'admin_waive')).toBe('waived');
    expect(nextScheduleStatus('paid', 'refund_issued')).toBe('refunded');
  });

  it('rejects illegal (state, event) pairs', () => {
    expect(() => nextScheduleStatus('pending', 'charge_succeeded')).toThrow(
      IllegalScheduleTransitionError,
    );
    expect(() => nextScheduleStatus('due', 'charge_succeeded')).toThrow(
      IllegalScheduleTransitionError,
    );
  });

  it('blocks any transition out of a terminal state', () => {
    expect(SCHEDULE_TERMINAL_STATES).toEqual(
      new Set(['restructured', 'defaulted', 'waived', 'refunded']),
    );
    for (const terminal of SCHEDULE_TERMINAL_STATES) {
      expect(() => nextScheduleStatus(terminal, 'payment_recovered')).toThrow(
        ScheduleTerminalStateError,
      );
    }
  });
});

describe('canScheduleTransition', () => {
  it('reports legality without throwing', () => {
    expect(canScheduleTransition('pending', 'due_date_reached')).toBe(true);
    expect(canScheduleTransition('pending', 'charge_succeeded')).toBe(false);
    expect(canScheduleTransition('defaulted', 'payment_recovered')).toBe(false);
    expect(canScheduleTransition('paid', 'refund_issued')).toBe(true);
  });
});
