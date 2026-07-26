import { Card, CardContent, CardHeader, CardTitle } from '@installment/ui';
import { Wallet, ShieldCheck, BadgeCheck, Layers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface Stat {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
}

const STATS: Stat[] = [
  { label: 'Pending payout', value: '—', hint: 'Net owed to you', icon: Wallet },
  { label: 'Reserve held', value: '—', hint: 'Default buffer', icon: ShieldCheck },
  { label: 'Lifetime settled', value: '—', hint: 'Paid out to date', icon: BadgeCheck },
  { label: 'Active plans', value: '—', hint: 'In repayment', icon: Layers },
];

export function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your settlement position at a glance. Live figures wire into{' '}
          <code className="text-foreground">/admin/merchants/:id/balances</code> once merchant
          scoping is added.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map(({ label, value, hint, icon: Icon }) => (
          <Card key={label}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="size-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tracking-tight">{value}</div>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Recent orders</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Orders and their installment-plan status will appear here.
        </CardContent>
      </Card>
    </div>
  );
}
