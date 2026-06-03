import { Money } from '../../shared/money/money';
import type { CustomerPlan, InstallmentScheduleRow } from '../schedules/customer-plans.service';

export interface StatementLine {
  sequenceNumber: number;
  dueDate: string;
  amountDue: string;
  amountPaid: string;
  status: string;
  paidAt: string | null;
}

export interface StatementSummary {
  orderAmount: string;
  downPayment: string;
  financedAmount: string;
  totalInterest: string;
  totalFees: string;
  totalPayable: string;
  amountPaid: string;
  outstanding: string;
  installmentCount: number;
}

export interface Statement {
  generatedAt: string;
  planId: string;
  applicationId: string;
  customerName: string;
  merchantName: string | null;
  businessModel: string;
  status: string;
  summary: StatementSummary;
  lines: StatementLine[];
}

export interface StatementInput {
  plan: CustomerPlan;
  schedule: InstallmentScheduleRow[];
  customerName: string;
  merchantName?: string | null;
  now?: Date;
}

const ghs = (pesewas: number): string => Money.fromPesewas(pesewas).format();
const dateOnly = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/** Builds a customer-facing statement (pure) from an already-loaded plan + schedule. */
export function buildStatement(input: StatementInput): Statement {
  const { plan, schedule } = input;
  const amountPaid = schedule.reduce((sum, r) => sum + r.amount_paid_pesewas, 0);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    planId: plan.id,
    applicationId: plan.application_id,
    customerName: input.customerName,
    merchantName: input.merchantName ?? null,
    businessModel: plan.business_model,
    status: plan.status,
    summary: {
      orderAmount: ghs(plan.order_amount_pesewas),
      downPayment: ghs(plan.down_payment_pesewas),
      financedAmount: ghs(plan.financed_amount_pesewas),
      totalInterest: ghs(plan.total_interest_pesewas),
      totalFees: ghs(plan.total_fees_pesewas),
      totalPayable: ghs(plan.total_payable_pesewas),
      amountPaid: ghs(amountPaid),
      outstanding: ghs(plan.outstanding_pesewas),
      installmentCount: schedule.length,
    },
    lines: schedule.map((r) => ({
      sequenceNumber: r.sequence_number,
      dueDate: r.due_date,
      amountDue: ghs(r.amount_due_pesewas),
      amountPaid: ghs(r.amount_paid_pesewas),
      status: r.status,
      paidAt: dateOnly(r.paid_at),
    })),
  };
}

// ---------------------------------------------------------------- CSV

/** RFC-4180 field: always quoted (money values contain thousands commas). */
function csvField(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(',');
}

/** Renders a statement as CSV (opens directly in Excel / Sheets). */
export function renderStatementCsv(s: Statement): string {
  const rows: string[] = [
    csvRow(['Installment Statement']),
    csvRow(['Generated', s.generatedAt]),
    csvRow(['Plan', s.planId]),
    csvRow(['Application', s.applicationId]),
    csvRow(['Customer', s.customerName]),
    csvRow(['Merchant', s.merchantName ?? '']),
    csvRow(['Business model', s.businessModel]),
    csvRow(['Status', s.status]),
    '',
    csvRow(['Order amount', s.summary.orderAmount]),
    csvRow(['Down payment', s.summary.downPayment]),
    csvRow(['Financed', s.summary.financedAmount]),
    csvRow(['Interest', s.summary.totalInterest]),
    csvRow(['Fees', s.summary.totalFees]),
    csvRow(['Total payable', s.summary.totalPayable]),
    csvRow(['Amount paid', s.summary.amountPaid]),
    csvRow(['Outstanding', s.summary.outstanding]),
    '',
    csvRow(['Sequence', 'Due date', 'Amount due', 'Amount paid', 'Status', 'Paid at']),
    ...s.lines.map((l) =>
      csvRow([l.sequenceNumber, l.dueDate, l.amountDue, l.amountPaid, l.status, l.paidAt ?? '']),
    ),
  ];
  return rows.join('\n');
}

// ---------------------------------------------------------------- HTML

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders a print-ready HTML statement (customers print → PDF from the browser). */
export function renderStatementHtml(s: Statement): string {
  const summaryRows = [
    ['Order amount', s.summary.orderAmount],
    ['Down payment', s.summary.downPayment],
    ['Financed', s.summary.financedAmount],
    ['Interest', s.summary.totalInterest],
    ['Fees', s.summary.totalFees],
    ['Total payable', s.summary.totalPayable],
    ['Amount paid', s.summary.amountPaid],
    ['Outstanding', s.summary.outstanding],
  ]
    .map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`)
    .join('');

  const lineRows = s.lines
    .map(
      (l) =>
        `<tr><td>${l.sequenceNumber}</td><td>${esc(l.dueDate)}</td><td>${esc(l.amountDue)}</td>` +
        `<td>${esc(l.amountPaid)}</td><td>${esc(l.status)}</td><td>${esc(l.paidAt ?? '')}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Installment Statement</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1a1a1a; margin: 2rem; }
  h1 { font-size: 1.25rem; }
  .meta { color: #555; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 0.9rem; }
  thead th { background: #f5f5f5; }
</style></head><body>
<h1>Installment Statement</h1>
<div class="meta">
  ${esc(s.customerName)}${s.merchantName ? ` &middot; ${esc(s.merchantName)}` : ''}<br>
  Plan ${esc(s.planId)} &middot; ${esc(s.businessModel)} &middot; ${esc(s.status)}<br>
  Generated ${esc(s.generatedAt)}
</div>
<table><tbody>${summaryRows}</tbody></table>
<table>
  <thead><tr><th>#</th><th>Due date</th><th>Amount due</th><th>Amount paid</th><th>Status</th><th>Paid at</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
</body></html>`;
}
