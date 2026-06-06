import { describe, expect, it } from 'vitest';
import {
  buildMerchantStatement,
  classifyStatementKind,
  renderMerchantStatementCsv,
  renderMerchantStatementHtml,
  type MerchantStatementEntry,
} from './merchant-statement';

const entry = (
  over: Partial<MerchantStatementEntry> &
    Pick<MerchantStatementEntry, 'transactionId' | 'direction' | 'amountPesewas'>,
): MerchantStatementEntry => ({
  occurredAt: '2026-03-10T08:00:00.000Z',
  description: 'x',
  ...over,
});

describe('classifyStatementKind', () => {
  it('classifies from the transaction id prefix, payout-reversal before payout', () => {
    expect(classifyStatementKind('accrue:plan:order_approved')).toBe('accrual');
    expect(classifyStatementKind('release:row:2026-03-10')).toBe('reserve_release');
    expect(classifyStatementKind('payout-reversal:abc')).toBe('payout_reversal');
    expect(classifyStatementKind('payout:abc')).toBe('payout');
    expect(classifyStatementKind('default:plan')).toBe('default_clawback');
    expect(classifyStatementKind('refund:sched:order_approved')).toBe('refund_reversal');
    expect(classifyStatementKind('seed:whatever')).toBe('other');
  });
});

describe('buildMerchantStatement', () => {
  it('carries opening forward, signs movements, and rolls up the period totals', () => {
    const s = buildMerchantStatement({
      merchantId: 'm1',
      merchantName: 'Acme',
      year: 2026,
      month: 3,
      openingBalancePesewas: 10_000,
      entries: [
        entry({
          transactionId: 'accrue:p1:order_approved',
          direction: 'credit',
          amountPesewas: 91_000,
        }),
        entry({
          transactionId: 'release:r1:2026-03-12',
          direction: 'credit',
          amountPesewas: 5_000,
        }),
        entry({ transactionId: 'payout:po1', direction: 'debit', amountPesewas: 100_000 }),
      ],
      now: new Date('2026-04-01T00:00:00.000Z'),
    });

    expect(s.period).toBe('2026-03');
    expect(s.periodStart).toBe('2026-03-01');
    expect(s.periodEnd).toBe('2026-03-31');
    expect(s.merchantName).toBe('Acme');

    // 10_000 + 91_000 + 5_000 − 100_000 = 6_000
    expect(s.summary.openingBalance).toBe('GHS 100.00');
    expect(s.summary.closingBalance).toBe('GHS 60.00');
    expect(s.summary.totalCredited).toBe('GHS 960.00'); // 96_000
    expect(s.summary.totalDebited).toBe('GHS 1,000.00'); // 100_000
    expect(s.summary.reserveReleased).toBe('GHS 50.00'); // 5_000
    expect(s.summary.paidOut).toBe('GHS 1,000.00'); // 100_000
    expect(s.summary.lineCount).toBe(3);

    expect(s.lines[0]!.kind).toBe('accrual');
    expect(s.lines[0]!.signedAmountPesewas).toBe(91_000);
    expect(s.lines[2]!.kind).toBe('payout');
    expect(s.lines[2]!.signedAmountPesewas).toBe(-100_000);
  });

  it('handles an empty month (closing == opening)', () => {
    const s = buildMerchantStatement({
      merchantId: 'm1',
      year: 2026,
      month: 2,
      openingBalancePesewas: 4_200,
      entries: [],
    });
    expect(s.periodEnd).toBe('2026-02-28');
    expect(s.summary.closingBalance).toBe('GHS 42.00');
    expect(s.summary.totalCredited).toBe('GHS 0.00');
    expect(s.lines).toHaveLength(0);
  });

  it('renders CSV and HTML containing the period and balances', () => {
    const s = buildMerchantStatement({
      merchantId: 'm1',
      merchantName: 'Acme',
      year: 2026,
      month: 3,
      openingBalancePesewas: 0,
      entries: [entry({ transactionId: 'payout:po1', direction: 'debit', amountPesewas: 100_000 })],
    });

    const csv = renderMerchantStatementCsv(s);
    expect(csv).toContain('Merchant Statement');
    expect(csv).toContain('2026-03');
    expect(csv).toContain('payout');

    const html = renderMerchantStatementHtml(s);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Merchant Statement');
    expect(html).toContain('Acme');
    expect(html).toContain('GHS');
  });
});
