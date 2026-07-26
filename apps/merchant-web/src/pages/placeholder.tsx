import { Card, CardContent, CardHeader, CardTitle } from '@installment/ui';
import { Hammer } from 'lucide-react';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Hammer className="size-4 text-primary" />
            Coming up next
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This screen is part of the Phase 10 build and lands in the next iteration.
        </CardContent>
      </Card>
    </div>
  );
}
