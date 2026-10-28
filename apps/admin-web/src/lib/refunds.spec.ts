import { describe, expect, it } from 'vitest';
import { REFUND_QUEUES } from '@installment/api-types';
import { REFUND_QUEUE_INFO, refundAction } from './refunds';

describe('refundAction', () => {
  it('offers to send only a refund nothing has been sent for', () => {
    expect(refundAction({ queue: 'to_send' })).toBe('send');
  });

  it('offers a hand payment where Paystack is not paying it', () => {
    expect(refundAction({ queue: 'failed' })).toBe('mark_paid');
    expect(refundAction({ queue: 'to_pay_by_hand' })).toBe('mark_paid');
  });

  it('offers a hand payment on an unresolved refund only after checking Paystack', () => {
    expect(refundAction({ queue: 'unresolved' })).toBe('mark_paid_after_check');
  });

  it('offers nothing for a refund Paystack is paying, or one already paid', () => {
    // Paying by hand as well, or sending again, would pay the customer twice.
    expect(refundAction({ queue: 'in_flight' })).toBeNull();
    expect(refundAction({ queue: 'paid' })).toBeNull();
  });

  it('describes every queue the API has', () => {
    for (const queue of REFUND_QUEUES) expect(REFUND_QUEUE_INFO[queue].label).toBeTruthy();
  });
});
