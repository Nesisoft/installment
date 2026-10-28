import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { useLedgerIntegrity } from '../lib/admin-api';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

/**
 * Whether the books balance, and where they do not. The hourly integrity cron
 * alerts on drift; this is what an operator opens when it does. The ledger is
 * append-only, so drift is compensated, never edited away — see
 * docs/runbooks/ledger-imbalance.md.
 */
export function LedgerPage() {
  const report = useLedgerIntegrity();

  if (report.isPending) return <LoadingState />;
  if (report.isError)
    return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const r = report.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledger"
        description={`Checked ${formatDateTime(r.checkedAt)}. Every transaction posts equal debits and credits, so the accounts must sum to exactly zero.`}
        actions={
          <StatusBadge
            status={r.healthy ? 'healthy' : 'failed'}
            label={r.healthy ? 'Balanced' : 'Drifted'}
          />
        }
      />

      {!r.healthy ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Unbalanced transactions</CardTitle>
            <CardDescription>
              Each of these posted unequal debits and credits. Do not edit or delete ledger rows:
              follow docs/runbooks/ledger-imbalance.md to book a compensating entry.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {r.unbalancedTransactions.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No single transaction is unbalanced, yet the accounts do not sum to zero. That
                points at rows written outside a transaction; the runbook covers it.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction</TableHead>
                    <TableHead className="text-right">Debits</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                    <TableHead className="text-right">Drift</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.unbalancedTransactions.map((t) => (
                    <TableRow key={t.transactionId}>
                      <TableCell className="font-mono text-xs">{t.transactionId}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatGhs(t.debitsPesewas)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatGhs(t.creditsPesewas)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-destructive">
                        {formatGhs(t.driftPesewas)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trial balance</CardTitle>
          <CardDescription>
            Balance is credits minus debits. Individual accounts are expected to be non-zero.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debits</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.trialBalance.rows.map((row) => (
                <TableRow key={row.accountType}>
                  <TableCell className="font-mono text-xs">{row.accountType}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(row.debitsPesewas)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(row.creditsPesewas)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(row.balancePesewas)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Total</TableCell>
                <TableCell />
                <TableCell />
                <TableCell
                  className={`text-right font-semibold tabular-nums ${r.trialBalance.balanced ? '' : 'text-destructive'}`}
                >
                  {formatGhs(r.trialBalance.totalPesewas)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
