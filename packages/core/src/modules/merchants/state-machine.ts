/**
 * Merchant lifecycle state machine.
 *
 *      pending_kyc ── activate ──▶ active ──suspend──▶ suspended
 *                                    │ ◀──reactivate────┘
 *                                    │
 *                                    └── offboard ──▶ offboarded
 *                                       (also from suspended)
 *
 * `offboarded` is terminal — no transitions out. Status changes flow
 * through {@link MerchantsService.transition} only, never via direct
 * status writes (Guiding principle #4).
 */
export type MerchantStatus = 'pending_kyc' | 'active' | 'suspended' | 'offboarded';

export type MerchantEvent = 'activate' | 'suspend' | 'reactivate' | 'offboard';

export const MERCHANT_STATUSES = [
  'pending_kyc',
  'active',
  'suspended',
  'offboarded',
] as const satisfies readonly MerchantStatus[];

type TransitionKey = `${MerchantStatus}:${MerchantEvent}`;

const TRANSITIONS: Partial<Record<TransitionKey, MerchantStatus>> = {
  'pending_kyc:activate': 'active',
  'active:suspend': 'suspended',
  'suspended:reactivate': 'active',
  'active:offboard': 'offboarded',
  'suspended:offboard': 'offboarded',
};

export class IllegalMerchantTransitionError extends Error {
  constructor(from: MerchantStatus, event: MerchantEvent) {
    super(`Cannot apply event "${event}" to merchant in status "${from}"`);
    this.name = 'IllegalMerchantTransitionError';
  }
}

export function nextMerchantStatus(from: MerchantStatus, event: MerchantEvent): MerchantStatus {
  const key: TransitionKey = `${from}:${event}`;
  const to = TRANSITIONS[key];
  if (!to) throw new IllegalMerchantTransitionError(from, event);
  return to;
}

export function canTransition(from: MerchantStatus, event: MerchantEvent): boolean {
  return TRANSITIONS[`${from}:${event}`] !== undefined;
}
