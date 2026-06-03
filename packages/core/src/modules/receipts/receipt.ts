import { Money } from '../../shared/money/money';
import type { CustomerPlan, InstallmentScheduleRow } from '../schedules/customer-plans.service';

export interface Receipt {
  receiptNumber: string;
  issuedAt: string;
  customerName: string;
  merchantName: string | null;
  planId: string;
  installmentSequence: number;
  amountPaid: string;
  paidAt: string | null;
  outstandingAfter: string;
  planStatus: string;
}

export interface ReceiptInput {
  plan: CustomerPlan;
  /** The PAID installment this receipt acknowledges. */
  installment: InstallmentScheduleRow;
  customerName: string;
  merchantName?: string | null;
  now?: Date;
}

const ghs = (pesewas: number): string => Money.fromPesewas(pesewas).format();

/** Builds a payment receipt (pure) from a paid installment + its plan. */
export function buildReceipt(input: ReceiptInput): Receipt {
  const { plan, installment } = input;
  return {
    receiptNumber: installment.provider_reference ?? installment.id,
    issuedAt: (input.now ?? new Date()).toISOString(),
    customerName: input.customerName,
    merchantName: input.merchantName ?? null,
    planId: plan.id,
    installmentSequence: installment.sequence_number,
    amountPaid: ghs(installment.amount_paid_pesewas),
    paidAt: installment.paid_at ? installment.paid_at.slice(0, 10) : null,
    outstandingAfter: ghs(plan.outstanding_pesewas),
    planStatus: plan.status,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders a print-ready HTML receipt (the customer prints → PDF, or it goes in an email). */
export function renderReceiptHtml(r: Receipt): string {
  const rows = [
    ['Receipt no.', r.receiptNumber],
    ['Customer', r.customerName],
    ['Merchant', r.merchantName ?? '—'],
    ['Plan', r.planId],
    ['Installment', `#${r.installmentSequence}`],
    ['Amount paid', r.amountPaid],
    ['Paid on', r.paidAt ?? '—'],
    ['Remaining balance', r.outstandingAfter],
  ]
    .map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Payment Receipt</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1a1a1a; margin: 2rem; max-width: 480px; }
  h1 { font-size: 1.25rem; }
  .meta { color: #555; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; width: 45%; }
  .paid { color: #137333; font-weight: 600; }
</style></head><body>
<h1>Payment Receipt <span class="paid">✓ PAID</span></h1>
<div class="meta">Issued ${esc(r.issuedAt)}</div>
<table><tbody>${rows}</tbody></table>
</body></html>`;
}
