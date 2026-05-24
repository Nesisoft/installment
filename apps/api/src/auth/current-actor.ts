import type { AuditActorType } from '@installment/core';
import type { AuthenticatedUser } from './decorators';

function toActorType(userType: string): AuditActorType {
  switch (userType) {
    case 'merchant':
      return 'merchant';
    case 'customer':
      return 'customer';
    case 'system':
      return 'system';
    default:
      return 'admin'; // admin / agent staff
  }
}

/** Maps the authenticated principal to the actor shape the core services expect. */
export function actorOf(user: AuthenticatedUser): { actorId: string; actorType: AuditActorType } {
  return { actorId: user.id, actorType: toActorType(user.userType) };
}

/** Coerce a string query param to a number (undefined when absent/empty). */
export const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);
