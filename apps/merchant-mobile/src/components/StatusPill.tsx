import React from 'react';
import type { CustomerPlanStatus, InstallmentStatus, OrderStatus } from '@installment/api-types';
import { Pill, type PillTone } from './Pill';

/**
 * An order's state, in the seller's words.
 *
 * The engine's vocabulary is not the shop's. `financing_active` is a fact about
 * a credit plan; what the seller needs to know is that the order is theirs to
 * pack, which is the same thing `paid` means to them — so both read NEW. The
 * mapping is exhaustive over `OrderStatus` on purpose: a status added to the
 * state machine and not to this table is a compile error rather than a blank
 * chip.
 */
const ORDER: Record<OrderStatus, { label: string; tone: PillTone }> = {
  pending_payment: { label: 'UNPAID', tone: 'neutral' },
  pending_approval: { label: 'WITH EJUA', tone: 'info' },
  paid: { label: 'NEW', tone: 'accent' },
  financing_active: { label: 'NEW', tone: 'accent' },
  fulfilling: { label: 'CONFIRMED', tone: 'primary' },
  shipped: { label: 'SHIPPED', tone: 'primary' },
  delivered: { label: 'DELIVERED', tone: 'primary' },
  completed: { label: 'COMPLETED', tone: 'neutral' },
  cancelled: { label: 'CANCELLED', tone: 'neutral' },
  payment_failed: { label: 'PAYMENT FAILED', tone: 'warn' },
  declined: { label: 'DECLINED', tone: 'neutral' },
  returned: { label: 'RETURNED', tone: 'warn' },
  defaulted: { label: 'DEFAULTED', tone: 'warn' },
};

export function OrderStatusPill({ status }: { status: OrderStatus }): React.ReactElement {
  const s = ORDER[status];
  return <Pill label={s?.label ?? String(status).toUpperCase()} tone={s?.tone ?? 'neutral'} />;
}

/** Whether an order is still waiting on the seller to acknowledge it. */
export function isAwaitingConfirmation(status: OrderStatus): boolean {
  return status === 'paid' || status === 'financing_active';
}

/**
 * A credit plan's state.
 *
 * Note what is NOT in this union: there is no `in_arrears`. A plan with a
 * missed payment stays `active` and the arrears live on the schedule rows, so
 * "late" has to be derived from those — hence the `late` prop rather than a
 * status this table could map.
 */
const PLAN: Record<CustomerPlanStatus, { label: string; tone: PillTone }> = {
  active: { label: 'ACTIVE', tone: 'primary' },
  completed: { label: 'COMPLETED', tone: 'neutral' },
  defaulted: { label: 'DEFAULTED', tone: 'accent' },
  cancelled: { label: 'CANCELLED', tone: 'neutral' },
  restructured: { label: 'RESTRUCTURED', tone: 'info' },
};

export function PlanStatusPill({
  status,
  late,
}: {
  status: CustomerPlanStatus;
  /** An active plan carrying an overdue instalment reads LATE, not ACTIVE. */
  late?: boolean;
}): React.ReactElement {
  if (late && status === 'active') return <Pill label="LATE" tone="warn" />;
  const s = PLAN[status];
  return <Pill label={s?.label ?? String(status).toUpperCase()} tone={s?.tone ?? 'neutral'} />;
}

/**
 * One schedule row's state, sentence case — these sit in a dense list, not on a
 * card, and twelve shouted words down the side of a schedule is unreadable.
 *
 * Twelve of them, because that is what the column's CHECK permits. Several
 * (`processing`, `retry_scheduled`, `in_collections`) are about the collection
 * machinery rather than the seller, but they are reachable states and a row
 * that rendered blank for one would look like a missing payment.
 */
const INSTALMENT: Record<InstallmentStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Upcoming', tone: 'neutral' },
  due: { label: 'Due', tone: 'info' },
  processing: { label: 'Collecting', tone: 'info' },
  paid: { label: 'Paid', tone: 'primary' },
  failed: { label: 'Failed', tone: 'accent' },
  retry_scheduled: { label: 'Retrying', tone: 'warn' },
  overdue: { label: 'Overdue', tone: 'accent' },
  in_collections: { label: 'In collections', tone: 'accent' },
  restructured: { label: 'Restructured', tone: 'info' },
  defaulted: { label: 'Defaulted', tone: 'accent' },
  waived: { label: 'Waived', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export function installmentLabel(status: InstallmentStatus): { label: string; tone: PillTone } {
  return INSTALMENT[status] ?? { label: String(status), tone: 'neutral' };
}

/** Statuses that mean the customer has fallen behind on this row. */
export function isLateInstallment(status: InstallmentStatus): boolean {
  return status === 'overdue' || status === 'in_collections' || status === 'defaulted';
}
