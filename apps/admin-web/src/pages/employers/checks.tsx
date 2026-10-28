import { useState } from 'react';
import { Button, Card, CardContent } from '@installment/ui';
import type { ListEmploymentParams } from '@installment/api-types';
import { useEmployment } from '../../lib/workforce-api';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';
import { EmploymentLinkRow } from '../../components/employment-link';

const PAGE = 50;

type View = 'waiting' | 'verified' | 'all';

const VIEWS: { value: View; label: string; params: ListEmploymentParams }[] = [
  {
    value: 'waiting',
    label: 'Waiting to be checked',
    params: { status: 'active', verified: false },
  },
  { value: 'verified', label: 'Verified', params: { verified: true } },
  { value: 'all', label: 'All links', params: {} },
];

/**
 * Jobs waiting to be confirmed, oldest first.
 *
 * Linking a customer to an employer is data entry; it lands the moment it is
 * saved. Verification is the separate, deliberate act the starter limit rests
 * on, so it gets a queue of its own rather than living only on each
 * customer's page.
 */
export function EmploymentChecksPage() {
  const [view, setView] = useState<View>('waiting');
  const [page, setPage] = useState(0);
  const params = VIEWS.find((v) => v.value === view)!.params;
  const list = useEmployment({ ...params, limit: PAGE, offset: page * PAGE });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employment checks"
        description="Confirm that customers hold the jobs they are linked to. Verified jobs at a live employer raise what a first-time customer may borrow."
      />

      <div className="flex flex-wrap gap-2" role="tablist">
        {VIEWS.map((v) => (
          <Button
            key={v.value}
            size="sm"
            role="tab"
            aria-selected={view === v.value}
            variant={view === v.value ? 'default' : 'outline'}
            onClick={() => {
              setView(v.value);
              setPage(0);
            }}
          >
            {v.label}
            {view === v.value && list.data ? (
              <span className="ml-1 tabular-nums opacity-70">{total}</span>
            ) : null}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="py-0">
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              message={view === 'waiting' ? 'Nothing is waiting to be checked.' : 'No links.'}
            />
          ) : (
            <div className="divide-y divide-border">
              {rows.map((l) => (
                <EmploymentLinkRow key={l.id} link={l} show="both" />
              ))}
            </div>
          )}
          {total > PAGE ? (
            <div className="flex items-center justify-between border-t border-border py-3 text-sm">
              <span className="text-muted-foreground">
                {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((n) => n - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
