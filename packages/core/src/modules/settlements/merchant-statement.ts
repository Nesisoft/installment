import { Money } from '../../shared/money/money';

/** One movement on the merchant's running account (a merchant_payable ledger entry). */
export interface MerchantStatementLine {
  occurredAt: string;
  date: string;
  transactionId: string;
  description: string;
  direction: 'debit' | 'credit';
  /** Always positive, GHS-formatted. */
  amount: string;
  /** + for credits (money owed to the merchant), − for debits. */
  signedAmountPesewas: number;
  /** Classified from the transaction id prefix. */
  kind: MerchantStatementKind;
}

export type MerchantStatementKind =
  | 'accrual'
  | 'reserve_release'
  | 'payout'
  | 'payout_reversal'
  | 'default_clawback'
  | 'refund_reversal'
  | 'other';

export interface MerchantStatementSummary {
  openingBalance: string;
  closingBalance: string;
  /** Money added to the merchant's account this period (sum of credits). */
  totalCredited: string;
  /** Money removed this period (payouts + claw-backs; sum of debits). */
  totalDebited: string;
  /** Of the credits, how much was reserve released back. */
  reserveReleased: string;
  /** Of the debits, how much actually paid out. */
  paidOut: string;
  lineCount: number;
}

export interface MerchantStatement {
  generatedAt: string;
  merchantId: string;
  merchantName: string | null;
  /** 'YYYY-MM'. */
  period: string;
  periodStart: string;
  periodEnd: string;
  summary: MerchantStatementSummary;
  lines: MerchantStatementLine[];
}

export interface MerchantStatementEntry {
  occurredAt: string;
  transactionId: string;
  description: string;
  direction: 'debit' | 'credit';
  amountPesewas: number;
}

export interface MerchantStatementInput {
  merchantId: string;
  merchantName?: string | null;
  /** 1-based month. */
  year: number;
  month: number;
  openingBalancePesewas: number;
  /** merchant_payable entries within the period, ascending by occurredAt. */
  entries: MerchantStatementEntry[];
  now?: Date;
}

const ghs = (pesewas: number): string => Money.fromPesewas(pesewas).format();
const dateOnly = (iso: string): string => iso.slice(0, 10);

/** Classifies a movement from its transaction id (payout-reversal before payout). */
export function classifyStatementKind(transactionId: string): MerchantStatementKind {
  if (transactionId.startsWith('accrue:')) return 'accrual';
  if (transactionId.startsWith('release:')) return 'reserve_release';
  if (transactionId.startsWith('payout-reversal:')) return 'payout_reversal';
  if (transactionId.startsWith('payout:')) return 'payout';
  if (transactionId.startsWith('default:')) return 'default_clawback';
  if (transactionId.startsWith('refund:')) return 'refund_reversal';
  return 'other';
}

/** Builds a monthly merchant account statement (pure) from already-loaded entries. */
export function buildMerchantStatement(input: MerchantStatementInput): MerchantStatement {
  const periodStartDate = new Date(Date.UTC(input.year, input.month - 1, 1));
  const periodEndDate = new Date(Date.UTC(input.year, input.month, 0)); // last day of month

  let running = input.openingBalancePesewas;
  let credited = 0;
  let debited = 0;
  let reserveReleased = 0;
  let paidOut = 0;

  const lines: MerchantStatementLine[] = input.entries.map((e) => {
    const kind = classifyStatementKind(e.transactionId);
    const signed = e.direction === 'credit' ? e.amountPesewas : -e.amountPesewas;
    running += signed;
    if (e.direction === 'credit') {
      credited += e.amountPesewas;
      if (kind === 'reserve_release') reserveReleased += e.amountPesewas;
    } else {
      debited += e.amountPesewas;
      if (kind === 'payout') paidOut += e.amountPesewas;
    }
    return {
      occurredAt: e.occurredAt,
      date: dateOnly(e.occurredAt),
      transactionId: e.transactionId,
      description: e.description,
      direction: e.direction,
      amount: ghs(e.amountPesewas),
      signedAmountPesewas: signed,
      kind,
    };
  });

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    merchantId: input.merchantId,
    merchantName: input.merchantName ?? null,
    period: `${input.year}-${String(input.month).padStart(2, '0')}`,
    periodStart: periodStartDate.toISOString().slice(0, 10),
    periodEnd: periodEndDate.toISOString().slice(0, 10),
    summary: {
      openingBalance: ghs(input.openingBalancePesewas),
      closingBalance: ghs(running),
      totalCredited: ghs(credited),
      totalDebited: ghs(debited),
      reserveReleased: ghs(reserveReleased),
      paidOut: ghs(paidOut),
      lineCount: lines.length,
    },
    lines,
  };
}

// ---------------------------------------------------------------- CSV

function csvField(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(',');
}

/** Renders the merchant statement as CSV (opens directly in Excel / Sheets). */
export function renderMerchantStatementCsv(s: MerchantStatement): string {
  const rows: string[] = [
    csvRow(['Merchant Statement']),
    csvRow(['Generated', s.generatedAt]),
    csvRow(['Merchant', s.merchantName ?? s.merchantId]),
    csvRow(['Merchant ID', s.merchantId]),
    csvRow(['Period', s.period]),
    csvRow(['From', s.periodStart]),
    csvRow(['To', s.periodEnd]),
    '',
    csvRow(['Opening balance', s.summary.openingBalance]),
    csvRow(['Credited', s.summary.totalCredited]),
    csvRow(['Debited', s.summary.totalDebited]),
    csvRow(['Reserve released', s.summary.reserveReleased]),
    csvRow(['Paid out', s.summary.paidOut]),
    csvRow(['Closing balance', s.summary.closingBalance]),
    '',
    csvRow(['Date', 'Description', 'Type', 'Direction', 'Amount', 'Transaction']),
    ...s.lines.map((l) =>
      csvRow([l.date, l.description, l.kind, l.direction, l.amount, l.transactionId]),
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

/** Renders a print-ready HTML merchant statement (print → PDF from the browser). */
export function renderMerchantStatementHtml(s: MerchantStatement): string {
  const summaryRows = [
    ['Opening balance', s.summary.openingBalance],
    ['Credited', s.summary.totalCredited],
    ['Debited', s.summary.totalDebited],
    ['Reserve released', s.summary.reserveReleased],
    ['Paid out', s.summary.paidOut],
    ['Closing balance', s.summary.closingBalance],
  ]
    .map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`)
    .join('');

  const lineRows = s.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.date)}</td><td>${esc(l.description)}</td><td>${esc(l.kind)}</td>` +
        `<td>${esc(l.direction)}</td><td style="text-align:right">${esc(l.amount)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Merchant Statement ${esc(s.period)}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1a1a1a; margin: 2rem; }
  h1 { font-size: 1.25rem; }
  .meta { color: #555; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 0.9rem; }
  thead th { background: #f5f5f5; }
</style></head><body>
<h1>Merchant Statement &middot; ${esc(s.period)}</h1>
<div class="meta">
  ${esc(s.merchantName ?? s.merchantId)}<br>
  ${esc(s.periodStart)} to ${esc(s.periodEnd)}<br>
  Generated ${esc(s.generatedAt)}
</div>
<table><tbody>${summaryRows}</tbody></table>
<table>
  <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Direction</th><th>Amount</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
</body></html>`;
}
