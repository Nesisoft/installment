import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardContent, Input, Label } from '@installment/ui';
import { PageHeader } from '../../components/page-header';

export function PlanLookupPage() {
  const navigate = useNavigate();
  const [id, setId] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = id.trim();
    if (trimmed) navigate(`/plans/${trimmed}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan operations"
        description="Look up a customer plan to view its schedule, record manual payments, refund installments, or write it off."
      />
      <Card className="max-w-xl">
        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="planId">Plan ID</Label>
              <Input
                id="planId"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="Plan UUID"
                autoFocus
              />
            </div>
            <Button type="submit" disabled={!id.trim()}>
              Open
            </Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            Tip: activating an approved application (Applications → detail) creates a plan and
            brings you here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
