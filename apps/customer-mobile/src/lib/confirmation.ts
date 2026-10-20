import type { OrderWithPlan } from '../features/types';

export type ConfirmationKind =
  | 'awaiting_payment'
  | 'in_review'
  | 'deposit_in_flight'
  | 'deposit_unpaid'
  | 'confirmed'
  | 'not_placed';

export interface ConfirmationView {
  kind: ConfirmationKind;
  /** Spinner and polling: the outcome is still arriving on its own. */
  waiting: boolean;
  title: string;
  body: string;
  /** The money line, when there is one to state. */
  amount: { label: string; pesewas: number } | null;
  /** Free returns and paying the vendor after the window: paid-in-full orders only. */
  returnsApply: boolean;
}

/** An order that did not go through, whatever the reason. */
const NOT_PLACED = ['cancelled', 'payment_failed', 'declined'];

/**
 * What the confirmation screen may truthfully say about an order.
 *
 * It read two statuses. Anything that was not `pending_payment` or
 * `pending_approval` got "Order confirmed. It's on the way." and the deposit
 * (or the order total) under "Paid today" — a declined or cancelled order
 * included, and an instalment order whose deposit was never paid: a card
 * attempt the server refused landed here and told the customer they had paid.
 * Whether money moved is read from the deposit row itself.
 */
export function describeConfirmation(order: OrderWithPlan): ConfirmationView {
  const returnsApply = order.payment_type === 'full' && Boolean(order.return_window_ends_at);
  const shipNote =
    order.fulfilment_method === 'pickup'
      ? `Ready for collection at ${order.pickup_hub?.name ?? 'your chosen hub'}.`
      : 'We will let you know as soon as it ships.';

  if (NOT_PLACED.includes(order.status)) {
    return {
      kind: 'not_placed',
      waiting: false,
      title: 'This order did not go through.',
      body:
        order.status === 'declined'
          ? 'Instalments were not approved this time. Nothing was charged.'
          : order.status === 'payment_failed'
            ? 'The payment did not complete, so nothing was charged.'
            : 'It was cancelled. Nothing was charged.',
      amount: null,
      returnsApply: false,
    };
  }

  if (order.status === 'pending_approval') {
    return {
      kind: 'in_review',
      waiting: true,
      title: 'Being reviewed.',
      body: 'We are checking your instalment request. This screen updates on its own once there is an answer — nothing is charged until then.',
      amount: null,
      returnsApply: false,
    };
  }

  if (order.status === 'pending_payment') {
    return {
      kind: 'awaiting_payment',
      waiting: true,
      title: 'Almost there.\nApprove it on your phone.',
      body: 'We are waiting for your payment to land. This screen updates on its own once it does.',
      amount: { label: 'To pay now', pesewas: order.total_pesewas },
      returnsApply,
    };
  }

  const plan = order.plan;
  if (order.payment_type === 'installment' && plan) {
    const deposit =
      plan.down_payment_pesewas > 0
        ? (order.schedule.find((row) => row.sequence_number === 1) ?? null)
        : null;
    if (deposit && deposit.status === 'processing') {
      return {
        kind: 'deposit_in_flight',
        waiting: true,
        title: 'Almost there.\nApprove it on your phone.',
        body: 'We are waiting for your deposit to land. This screen updates on its own once it does.',
        amount: { label: 'To pay now', pesewas: deposit.amount_due_pesewas },
        returnsApply: false,
      };
    }
    if (deposit && deposit.status !== 'paid') {
      return {
        kind: 'deposit_unpaid',
        waiting: false,
        title: 'Your deposit is not paid yet.',
        body: 'Your plan is approved. Pay the deposit from your order to start it.',
        amount: { label: 'Deposit due', pesewas: deposit.amount_due_pesewas },
        returnsApply: false,
      };
    }
    return {
      kind: 'confirmed',
      waiting: false,
      title: "Order confirmed.\nIt's on the way.",
      body: shipNote,
      amount: deposit ? { label: 'Paid today', pesewas: deposit.amount_paid_pesewas } : null,
      returnsApply: false,
    };
  }

  return {
    kind: 'confirmed',
    waiting: false,
    title: "Order confirmed.\nIt's on the way.",
    body: shipNote,
    amount: { label: 'Paid', pesewas: order.total_pesewas },
    returnsApply,
  };
}
