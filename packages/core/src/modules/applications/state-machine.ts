/**
 * Application decision lifecycle.
 *
 *   pending ──approve──▶ approved        (terminal)
 *           ──decline──▶ declined        (terminal)
 *           ──counter_offer──▶ counter_offered
 *           ──refer_manual──▶ manual_review
 *           ──expire──▶ expired          (terminal)
 *           ──cancel──▶ cancelled        (terminal)
 *
 *   manual_review ──{approve,decline,counter_offer,expire,cancel}──▶ …
 *   counter_offered ──accept_counter──▶ approved
 *                   ──{decline,expire,cancel}──▶ …
 */
export type ApplicationStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'counter_offered'
  | 'manual_review'
  | 'expired'
  | 'cancelled';

export type ApplicationEvent =
  | 'approve'
  | 'decline'
  | 'counter_offer'
  | 'refer_manual'
  | 'accept_counter'
  | 'expire'
  | 'cancel';

type Key = `${ApplicationStatus}:${ApplicationEvent}`;

const TRANSITIONS: Partial<Record<Key, ApplicationStatus>> = {
  'pending:approve': 'approved',
  'pending:decline': 'declined',
  'pending:counter_offer': 'counter_offered',
  'pending:refer_manual': 'manual_review',
  'pending:expire': 'expired',
  'pending:cancel': 'cancelled',

  'manual_review:approve': 'approved',
  'manual_review:decline': 'declined',
  'manual_review:counter_offer': 'counter_offered',
  'manual_review:expire': 'expired',
  'manual_review:cancel': 'cancelled',

  'counter_offered:accept_counter': 'approved',
  'counter_offered:decline': 'declined',
  'counter_offered:expire': 'expired',
  'counter_offered:cancel': 'cancelled',
};

export const APPLICATION_TERMINAL_STATES: ReadonlySet<ApplicationStatus> = new Set([
  'approved',
  'declined',
  'expired',
  'cancelled',
]);

export class IllegalApplicationTransitionError extends Error {
  constructor(from: ApplicationStatus, event: ApplicationEvent) {
    super(`Cannot apply event "${event}" to application in status "${from}"`);
    this.name = 'IllegalApplicationTransitionError';
  }
}

export function nextApplicationStatus(
  from: ApplicationStatus,
  event: ApplicationEvent,
): ApplicationStatus {
  const to = TRANSITIONS[`${from}:${event}`];
  if (!to) throw new IllegalApplicationTransitionError(from, event);
  return to;
}

export function canApplicationTransition(
  from: ApplicationStatus,
  event: ApplicationEvent,
): boolean {
  return TRANSITIONS[`${from}:${event}`] !== undefined;
}
