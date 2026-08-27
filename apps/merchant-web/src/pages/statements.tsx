import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { useApi } from '@installment/web-kit';
import { Download, ExternalLink } from 'lucide-react';
import { useMerchantStatement } from '../lib/merchant-api';
import { formatDate } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold">{value}</dd>
    </div>
  );
}

export function StatementsPage() {
  const api = useApi();
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const statement = useMerchantStatement(year, month);

  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1, now.getUTCFullYear() - 2];

  async function open(format: 'html' | 'csv') {
    const { data } = await api.get<string>(`/merchant/statement.${format}`, {
      params: { year, month },
      responseType: 'text',
    });
    const type = format === 'csv' ? 'text/csv' : 'text/html';
    const url = URL.createObjectURL(new Blob([data], { type }));
    if (format === 'csv') {
      const a = document.createElement('a');
      a.href = url;
      a.download = `merchant-statement-${year}-${String(month).padStart(2, '0')}.csv`;
      a.click();
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Statements"
        description="Your monthly account activity."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => void open('html')}>
              <ExternalLink />
              Print
            </Button>
            <Button variant="outline" size="sm" onClick={() => void open('csv')}>
              <Download />
              CSV
            </Button>
          </div>
        }
      />

      {statement.isPending ? (
        <LoadingState />
      ) : statement.isError ? (
        <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary — {statement.data.period}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Opening balance" value={statement.data.summary.openingBalance} />
                <Field label="Closing balance" value={statement.data.summary.closingBalance} />
                <Field label="Credited" value={statement.data.summary.totalCredited} />
                <Field label="Debited" value={statement.data.summary.totalDebited} />
                <Field label="Reserve released" value={statement.data.summary.reserveReleased} />
                <Field label="Paid out" value={statement.data.summary.paidOut} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {statement.data.lines.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No activity this month.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.data.lines.map((l, i) => (
                      <TableRow key={`${l.transactionId}-${i}`}>
                        <TableCell className="text-muted-foreground">
                          {formatDate(l.date)}
                        </TableCell>
                        <TableCell>{l.description}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {l.kind.replace(/_/g, ' ')}
                        </TableCell>
                        <TableCell
                          className={
                            l.direction === 'credit'
                              ? 'text-right text-success'
                              : 'text-right text-destructive'
                          }
                        >
                          {l.direction === 'credit' ? '+' : '−'}
                          {l.amount}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
