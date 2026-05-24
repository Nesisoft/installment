/**
 * Two cooperating state machines:
 *
 *   employers:               pending → active → {paused, terminated}
 *                                       paused → {active, terminated}
 *                                       terminated is terminal
 *
 *   customer_employment:     active → {left_employer, on_leave, suspended}
 *                                   ← reinstate/return_from_leave/rejoin
 */

// ---------------------------------------------------------------- employers

export type EmployerStatus = 'pending' | 'active' | 'paused' | 'terminated';
export type EmployerEvent = 'activate' | 'pause' | 'resume' | 'terminate';

const EMPLOYER_TRANSITIONS: Partial<Record<`${EmployerStatus}:${EmployerEvent}`, EmployerStatus>> =
  {
    'pending:activate': 'active',
    'active:pause': 'paused',
    'paused:resume': 'active',
    'active:terminate': 'terminated',
    'paused:terminate': 'terminated',
  };

export class IllegalEmployerTransitionError extends Error {
  constructor(from: EmployerStatus, event: EmployerEvent) {
    super(`Cannot apply event "${event}" to employer in status "${from}"`);
    this.name = 'IllegalEmployerTransitionError';
  }
}

export function nextEmployerStatus(from: EmployerStatus, event: EmployerEvent): EmployerStatus {
  const to = EMPLOYER_TRANSITIONS[`${from}:${event}`];
  if (!to) throw new IllegalEmployerTransitionError(from, event);
  return to;
}

// ----------------------------------------------------- customer_employment

export type EmploymentStatus = 'active' | 'left_employer' | 'on_leave' | 'suspended';
export type EmploymentEvent =
  | 'leave_employer'
  | 'take_leave'
  | 'return_from_leave'
  | 'suspend'
  | 'reinstate'
  | 'rejoin';

const EMPLOYMENT_TRANSITIONS: Partial<
  Record<`${EmploymentStatus}:${EmploymentEvent}`, EmploymentStatus>
> = {
  'active:leave_employer': 'left_employer',
  'active:take_leave': 'on_leave',
  'on_leave:return_from_leave': 'active',
  'active:suspend': 'suspended',
  'suspended:reinstate': 'active',
  'left_employer:rejoin': 'active',
};

export class IllegalEmploymentTransitionError extends Error {
  constructor(from: EmploymentStatus, event: EmploymentEvent) {
    super(`Cannot apply event "${event}" to employment in status "${from}"`);
    this.name = 'IllegalEmploymentTransitionError';
  }
}

export function nextEmploymentStatus(
  from: EmploymentStatus,
  event: EmploymentEvent,
): EmploymentStatus {
  const to = EMPLOYMENT_TRANSITIONS[`${from}:${event}`];
  if (!to) throw new IllegalEmploymentTransitionError(from, event);
  return to;
}
