import { describe, expect, it } from 'vitest';
import type { InstallmentRow, OrderWithPlan } from '../features/types';
import { describeConfirmation } from './confirmation';

function row(sequence: number, over: Partial<InstallmentRow> = {}): InstallmentRow {
  return {
    id: `r${sequence}`,
    customer_plan_id: 'p1',
    sequence_number: sequence,
    amount_due_pesewas: 13_400,
    amount_paid_pesewas: 0,
    late_fee_pesewas: 0,
    due_date: '2026-10-20',
    grace_until_date: '2026-10-23',
    status: 'pending',
    paid_at: null,
    attempt_count: 0,
    next_retry_at: null,
    ...over,
  };
}

function order(over: Partial<OrderWithPlan> = {}): OrderWithPlan {
  return {
    id: 'o1',
    order_number: 'ORD-1',
    payment_type: 'installment',
    status: 'financing_active',
    total_pesewas: 33_500,
    fulfilment_method: 'courier',
    return_window_ends_at: null,
    plan: { down_payment_pesewas: 13_400 },
    schedule: [row(1), row(2, { amount_due_pesewas: 6_700 })],
    pickup_hub: null,
    ...over,
  } as unknown as OrderWithPlan;
}

describe('describeConfirmation', () => {
  it('never says an unpaid deposit was paid', () => {
    // The card path the server refuses landed here: an approved plan, deposit
    // pending. It read "Order confirmed" with GHS 134 "Paid today".
    const v = describeConfirmation(order());
    expect(v.kind).toBe('deposit_unpaid');
    expect(v.title).not.toMatch(/confirmed/i);
    expect(v.amount).toEqual({ label: 'Deposit due', pesewas: 13_400 });
  });

  it('waits on a deposit that is being charged', () => {
    const v = describeConfirmation(order({ schedule: [row(1, { status: 'processing' })] }));
    expect(v.kind).toBe('deposit_in_flight');
    expect(v.waiting).toBe(true);
  });

  it('confirms once the deposit is paid, with what was paid', () => {
    const v = describeConfirmation(
      order({ schedule: [row(1, { status: 'paid', amount_paid_pesewas: 13_400 })] }),
    );
    expect(v.kind).toBe('confirmed');
    expect(v.amount).toEqual({ label: 'Paid today', pesewas: 13_400 });
  });

  it('does not show the order total as paid on a plan with no deposit', () => {
    const v = describeConfirmation(
      order({ plan: { down_payment_pesewas: 0 } as OrderWithPlan['plan'] }),
    );
    expect(v.kind).toBe('confirmed');
    expect(v.amount).toBeNull();
  });

  it('says a declined, cancelled or failed order did not go through', () => {
    for (const status of ['declined', 'cancelled', 'payment_failed'] as const) {
      const v = describeConfirmation(order({ status }));
      expect(v.kind).toBe('not_placed');
      expect(v.title).not.toMatch(/confirmed/i);
      expect(v.amount).toBeNull();
    }
  });

  it('does not ask a customer under credit review to approve a prompt', () => {
    const v = describeConfirmation(order({ status: 'pending_approval' }));
    expect(v.kind).toBe('in_review');
    expect(v.title).not.toMatch(/phone/i);
  });

  it('promises free returns on paid-in-full orders only', () => {
    const window = { return_window_ends_at: '2026-10-30T00:00:00Z' };
    expect(describeConfirmation(order({ ...window })).returnsApply).toBe(false);
    expect(
      describeConfirmation(
        order({ ...window, payment_type: 'full', status: 'paid', plan: null, schedule: [] }),
      ).returnsApply,
    ).toBe(true);
  });

  it('asks for approval on a paid-in-full order still awaiting payment', () => {
    const v = describeConfirmation(
      order({ payment_type: 'full', status: 'pending_payment', plan: null, schedule: [] }),
    );
    expect(v.kind).toBe('awaiting_payment');
    expect(v.amount).toEqual({ label: 'To pay now', pesewas: 33_500 });
  });
});
