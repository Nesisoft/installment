import { Button, Spinner } from '@installment/ui';
import { apiErrorMessage } from '@installment/web-kit';
import { AlertCircle, Inbox } from 'lucide-react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="grid place-items-center py-12">
      <Spinner label={label} />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="text-sm text-muted-foreground">{apiErrorMessage(error)}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <Inbox className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}
