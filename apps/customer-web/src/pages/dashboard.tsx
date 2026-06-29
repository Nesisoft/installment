import { useAuth } from '@installment/web-kit';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@installment/ui';
import { CalendarClock, Receipt } from 'lucide-react';

export function DashboardPage() {
  const { session } = useAuth();

  return (
    <div className="space-y-5">
      <section className="rounded-lg bg-primary p-5 text-primary-foreground shadow-sm">
        <p className="text-sm/5 text-primary-foreground/80">Welcome back</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">Your plans</p>
        <p className="mt-3 text-sm text-primary-foreground/80">
          Upcoming payments, history and pay-early all live here.
        </p>
      </section>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="size-4 text-primary" />
            Upcoming payments
          </CardTitle>
          <CardDescription>
            Once your `/me/plans` data is wired in, your next instalments show here.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No payments to show yet.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="size-4 text-primary" />
            Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <p>
            User ID: <span className="font-mono text-foreground">{session?.userId}</span>
          </p>
          <p>
            Signed in via <span className="text-foreground">phone OTP</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
