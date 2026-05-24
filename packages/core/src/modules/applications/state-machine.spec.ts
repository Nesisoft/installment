import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TERMINAL_STATES,
  IllegalApplicationTransitionError,
  canApplicationTransition,
  nextApplicationStatus,
  type ApplicationEvent,
} from './state-machine';

describe('applications state machine', () => {
  it('routes pending to every decision outcome + expire/cancel', () => {
    expect(nextApplicationStatus('pending', 'approve')).toBe('approved');
    expect(nextApplicationStatus('pending', 'decline')).toBe('declined');
    expect(nextApplicationStatus('pending', 'counter_offer')).toBe('counter_offered');
    expect(nextApplicationStatus('pending', 'refer_manual')).toBe('manual_review');
    expect(nextApplicationStatus('pending', 'expire')).toBe('expired');
    expect(nextApplicationStatus('pending', 'cancel')).toBe('cancelled');
  });

  it('lets manual_review be decided and counter_offered be accepted', () => {
    expect(nextApplicationStatus('manual_review', 'approve')).toBe('approved');
    expect(nextApplicationStatus('manual_review', 'counter_offer')).toBe('counter_offered');
    expect(nextApplicationStatus('counter_offered', 'accept_counter')).toBe('approved');
    expect(nextApplicationStatus('counter_offered', 'decline')).toBe('declined');
  });

  it('treats approved/declined/expired/cancelled as terminal', () => {
    const events: ApplicationEvent[] = [
      'approve',
      'decline',
      'counter_offer',
      'refer_manual',
      'accept_counter',
      'expire',
      'cancel',
    ];
    for (const state of APPLICATION_TERMINAL_STATES) {
      for (const event of events) {
        expect(() => nextApplicationStatus(state, event)).toThrow(
          IllegalApplicationTransitionError,
        );
      }
    }
  });

  it('rejects nonsensical transitions', () => {
    expect(() => nextApplicationStatus('pending', 'accept_counter')).toThrow(
      IllegalApplicationTransitionError,
    );
    expect(canApplicationTransition('counter_offered', 'accept_counter')).toBe(true);
    expect(canApplicationTransition('pending', 'accept_counter')).toBe(false);
  });
});
