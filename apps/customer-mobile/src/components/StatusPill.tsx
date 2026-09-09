import React from 'react';
import { Pill, type PillTone } from './Pill';
import type { OrderStatus, ReturnStatus } from '../features/types';

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

/**
 * Return status, as the buyer reads it.
 *
 * The seller's queue labels the same four values `WAITING ON YOU` / `APPROVED`
 * / `REFUSED` / `WITHDRAWN` (`merchant-mobile/app/returns/index.tsx`). Two of
 * those are deliberately said differently here, and the pair is the point:
 * `requested` is "waiting on YOU" to the seller and "waiting on the SELLER" to
 * the buyer — one status, and each side told whose move it is. `cancelled` is
 * the one the buyer causes, so it reads in their voice: they withdrew it,
 * nobody refused it.
 *
 * `REFUSED` is deliberately the same word on both sides. A seller who declined
 * a return and a buyer who was refused one should be able to talk about it.
 */
const RETURN_STATUS: Record<ReturnStatus, { label: string; tone: PillTone }> = {
  requested: { label: 'WAITING ON THE SELLER', tone: 'warn' },
  approved: { label: 'AGREED', tone: 'success' },
  rejected: { label: 'REFUSED', tone: 'neutral' },
  cancelled: { label: 'YOU WITHDREW THIS', tone: 'neutral' },
};

export function ReturnStatusPill({ status }: { status: ReturnStatus }): React.ReactElement {
  const s = RETURN_STATUS[status] ?? { label: status.toUpperCase(), tone: 'neutral' as PillTone };
  return <Pill label={s.label} tone={s.tone} />;
}
