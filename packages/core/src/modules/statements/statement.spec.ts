import { describe, expect, it } from 'vitest';
import {
  buildStatement,
  renderStatementCsv,
  renderStatementHtml,
  type StatementInput,
} from './statement';
import type { CustomerPlan, InstallmentScheduleRow } from '../schedules/customer-plans.service';

const plan = {
  id: 'plan-1',
  application_id: 'app-1',
  business_model: 'bnpl',
  status: 'active',
  order_amount_pesewas: 100_000,
  down_payment_pesewas: 0,
  financed_amount_pesewas: 100_000,
  total_interest_pesewas: 0,
  total_fees_pesewas: 0,
  total_payable_pesewas: 100_000,
  outstanding_pesewas: 75_000,
} as unknown as CustomerPlan;

const line = (over: Partial<InstallmentScheduleRow>): InstallmentScheduleRow =>
  ({
    sequence_number: 1,
    due_date: '2026-01-08',
    amount_due_pesewas: 25_000,
    amount_paid_pesewas: 0,
    late_fee_pesewas: 0,
    status: 'pending',
    paid_at: null,
    ...over,
  }) as unknown as InstallmentScheduleRow;

const schedule: InstallmentScheduleRow[] = [
  line({
    sequence_number: 1,
    amount_paid_pesewas: 25_000,
    status: 'paid',
    paid_at: '2026-01-08T09:00:00.000Z',
    due_date: '2026-01-08',
  }),
  line({ sequence_number: 2, due_date: '2026-01-15' }),
  line({ sequence_number: 3, due_date: '2026-01-22' }),
  line({ sequence_number: 4, due_date: '2026-01-29' }),
];

const input: StatementInput = {
  plan,
  schedule,
  customerName: 'Ama Mensah',
  merchantName: 'Acme Electronics',
  now: new Date('2026-01-10T00:00:00.000Z'),
};

describe('buildStatement', () => {
  it('summarises the plan and formats money as GHS', () => {
    const s = buildStatement(input);
    expect(s.planId).toBe('plan-1');
    expect(s.customerName).toBe('Ama Mensah');
    expect(s.summary.totalPayable).toBe('GHS 1,000.00');
    expect(s.summary.outstanding).toBe('GHS 750.00');
    expect(s.summary.amountPaid).toBe('GHS 250.00'); // sum of paid installments
    expect(s.summary.installmentCount).toBe(4);
  });

  it('maps each installment into a line with a date-only paidAt', () => {
    const s = buildStatement(input);
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]).toMatchObject({
      sequenceNumber: 1,
      dueDate: '2026-01-08',
      amountDue: 'GHS 250.00',
      amountPaid: 'GHS 250.00',
      status: 'paid',
      paidAt: '2026-01-08',
    });
    expect(s.lines[1]!.paidAt).toBeNull();
  });
});

describe('renderStatementCsv', () => {
  it('quotes every field so thousands-commas survive', () => {
    const csv = renderStatementCsv(buildStatement(input));
    expect(csv).toContain('"Total payable","GHS 1,000.00"');
    expect(csv).toContain('"Sequence","Due date","Amount due","Amount paid","Status","Paid at"');
    expect(csv).toContain('"1","2026-01-08","GHS 250.00","GHS 250.00","paid","2026-01-08"');
  });
});

describe('renderStatementHtml', () => {
  it('produces an HTML doc and escapes customer-supplied text', () => {
    const html = renderStatementHtml(buildStatement({ ...input, customerName: 'A<b> & "co"' }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('A&lt;b&gt; &amp; &quot;co&quot;');
    expect(html).not.toContain('<b>'); // raw tag must not leak through
  });
});
