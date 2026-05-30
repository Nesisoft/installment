import { describe, expect, it } from 'vitest';
import { buildReceipt, renderReceiptHtml, type ReceiptInput } from './receipt';
import type { CustomerPlan, InstallmentScheduleRow } from '../schedules/customer-plans.service';

const plan = {
  id: 'plan-1',
  status: 'active',
  outstanding_pesewas: 375_000,
} as unknown as CustomerPlan;

const installment = {
  id: 'sched-1',
  sequence_number: 1,
  amount_paid_pesewas: 125_000,
  status: 'paid',
  paid_at: '2026-01-08T09:30:00.000Z',
  provider_reference: 'INSTL-sched-1-1',
} as unknown as InstallmentScheduleRow;

const input: ReceiptInput = {
  plan,
  installment,
  customerName: 'Ama Mensah',
  merchantName: 'Acme Electronics',
  now: new Date('2026-01-08T10:00:00.000Z'),
};

describe('buildReceipt', () => {
  it('summarises a paid installment with GHS money and a date-only paid date', () => {
    const r = buildReceipt(input);
    expect(r).toMatchObject({
      receiptNumber: 'INSTL-sched-1-1',
      customerName: 'Ama Mensah',
      merchantName: 'Acme Electronics',
      planId: 'plan-1',
      installmentSequence: 1,
      amountPaid: 'GHS 1,250.00',
      paidAt: '2026-01-08',
      outstandingAfter: 'GHS 3,750.00',
      planStatus: 'active',
    });
  });

  it('falls back to the schedule id when no provider reference is present', () => {
    const r = buildReceipt({
      ...input,
      installment: {
        ...installment,
        provider_reference: null,
      } as unknown as InstallmentScheduleRow,
    });
    expect(r.receiptNumber).toBe('sched-1');
  });
});

describe('renderReceiptHtml', () => {
  it('produces an HTML doc and escapes customer-supplied text', () => {
    const html = renderReceiptHtml(buildReceipt({ ...input, customerName: 'A<b> & "co"' }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('GHS 1,250.00');
    expect(html).toContain('A&lt;b&gt; &amp; &quot;co&quot;');
    expect(html).not.toContain('<b>');
  });
});
