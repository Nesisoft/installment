import React from 'react';
import { Pill, type PillTone } from './Pill';
import type { OrderStatus } from '../features/types';

/**
 * Order status, as a customer reads it.
 *
 * The engine's vocabulary (`financing_active`, `pending_approval`) is
 * bookkeeping. What a shopper needs to know is where their order is and whether
 * anything is expected of them — so the mapping is deliberately not one-to-one
 * with the database, and `pending_payment` becomes an instruction rather than a
 * state.
 */
const ORDER_STATUS: Record<OrderStatus, { label: string; tone: PillTone }> = {
  pending_payment: { label: 'PAY NOW', tone: 'accent' },
  pending_approval: { label: 'CHECKING', tone: 'warn' },
  paid: { label: 'PAID', tone: 'success' },
  financing_active: { label: 'PAYING IN INSTALMENTS', tone: 'accent' },
  fulfilling: { label: 'PREPARING', tone: 'neutral' },
  shipped: { label: 'ON THE WAY', tone: 'accent' },
  delivered: { label: 'DELIVERED', tone: 'success' },
  completed: { label: 'COMPLETED', tone: 'success' },
  cancelled: { label: 'CANCELLED', tone: 'neutral' },
  payment_failed: { label: 'PAYMENT FAILED', tone: 'accent' },
  declined: { label: 'DECLINED', tone: 'neutral' },
  returned: { label: 'RETURNED', tone: 'neutral' },
  defaulted: { label: 'IN ARREARS', tone: 'accent' },
};

export function OrderStatusPill({ status }: { status: OrderStatus }): React.ReactElement {
  const s = ORDER_STATUS[status] ?? { label: status.toUpperCase(), tone: 'neutral' as PillTone };
  return <Pill label={s.label} tone={s.tone} />;
}

/**
 * Instalment status.
 *
 * `overdue` here means past the grace date, not merely past the due date —
 * inside grace an instalment is late but costs nothing, and telling someone
 * they are overdue while they still have days in hand is simply untrue.
 */
export function InstallmentStatusPill({
  status,
  overdue,
}: {
  status: string;
  overdue?: boolean;
}): React.ReactElement {
  if (status === 'paid') return <Pill label="PAID" tone="success" />;
  if (status === 'refunded') return <Pill label="REFUNDED" tone="neutral" />;
  if (status === 'processing') return <Pill label="PAYING" tone="accent" />;
  if (status === 'in_collections') return <Pill label="IN COLLECTIONS" tone="accent" />;
  if (overdue || status === 'overdue') return <Pill label="OVERDUE" tone="accent" />;
  if (status === 'failed' || status === 'retry_scheduled') {
    return <Pill label="RETRYING" tone="warn" />;
  }
  if (status === 'due') return <Pill label="DUE" tone="warn" />;
  return <Pill label="UPCOMING" tone="neutral" />;
}
