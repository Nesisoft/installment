import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { Check, X } from 'lucide-react';
import type { RuleResult } from '@installment/api-types';

export function RuleBreakdown({ rules }: { rules: RuleResult[] }) {
  if (!rules || rules.length === 0) {
    return <p className="text-sm text-muted-foreground">No rules were recorded.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead>Category</TableHead>
          <TableHead className="text-center">Passed</TableHead>
          <TableHead className="text-right">Points</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <TableRow key={r.ruleId}>
            <TableCell className="font-medium">{r.ruleId}</TableCell>
            <TableCell>
              <Badge variant={r.category === 'hard_gate' ? 'danger' : 'muted'}>{r.category}</Badge>
            </TableCell>
            <TableCell className="text-center">
              {r.passed ? (
                <Check className="mx-auto size-4 text-success" />
              ) : (
                <X className="mx-auto size-4 text-destructive" />
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.points}</TableCell>
            <TableCell className="text-muted-foreground">{r.reason ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
