import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  Input,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import type { AdminStoreRow, StoreStatus, StoreTransitionEvent } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import {
  useAdminStoreCounts,
  useAdminStores,
  useTransitionAnyStore,
} from '../../lib/catalogue-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE = 50;

const FILTERS: { value: StoreStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Waiting to open' },
  { value: 'active', label: 'Open' },
  { value: 'suspended', label: 'Closed' },
];

const STATUS_WORDS: Record<StoreStatus, string> = {
  draft: 'Waiting to open',
  active: 'Open',
  suspended: 'Closed',
};

const NEXT: Record<StoreStatus, { event: StoreTransitionEvent; label: string }> = {
  draft: { event: 'activate', label: 'Open the shop' },
  active: { event: 'suspend', label: 'Close the shop' },
  suspended: { event: 'unsuspend', label: 'Re-open the shop' },
};

/**
 * Every shop on the marketplace, those waiting for a decision first.
 *
 * A shop can already be opened from its seller's page, which is where the KYC
 * review happens. This is for the other direction — finding a shop by name and
 * closing it — and for seeing at a glance which open shops have a seller who
 * is not active, since nothing sells unless both are.
 */
export function StoresListPage() {
  const [filter, setFilter] = useState<StoreStatus | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [acting, setActing] = useState<string | null>(null);

  const counts = useAdminStoreCounts();
  const list = useAdminStores({
    ...(filter ? { status: filter } : {}),
    ...(q ? { q } : {}),
    limit: PAGE,
    offset: page * PAGE,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setQ(search.trim());
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shops"
        description="Every seller's shopfront. Shops waiting to open come first."
        actions={
          <form onSubmit={onSearch} className="flex gap-2">
            <Input
              aria-label="Search shop names"
              placeholder="Search shop names"
              className="h-9 w-56"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              Find
            </Button>
          </form>
        }
      />

      <div className="flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((f) => {
          const n = counts.data ? counts.data[f.value || 'all'] : undefined;
          return (
            <Button
              key={f.value || 'all'}
              size="sm"
              role="tab"
              aria-selected={filter === f.value}
              variant={filter === f.value ? 'default' : 'outline'}
              onClick={() => {
                setFilter(f.value);
                setPage(0);
                setActing(null);
              }}
            >
              {f.label}
              {n !== undefined ? <span className="ml-1 tabular-nums opacity-70">{n}</span> : null}
            </Button>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState message="No shops match." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Seller</TableHead>
                  <TableHead className="text-right">Listings</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <Fragment key={s.id}>
                    <TableRow>
                      <TableCell>
                        <div className="font-medium">{s.display_name}</div>
                        <div className="text-xs text-muted-foreground">
                          /{s.slug}
                          {s.city || s.region
                            ? ` · ${[s.city, s.region].filter(Boolean).join(', ')}`
                            : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/merchants/${s.merchant_id}`}
                          className="text-primary hover:underline"
                        >
                          {s.merchant_name ?? 'Unknown seller'}
                        </Link>
                        {s.merchant_status && s.merchant_status !== 'active' ? (
                          <div className="text-xs text-warning-foreground">
                            Seller is {s.merchant_status.replace(/_/g, ' ')}
                            {s.status === 'active' ? ' — nothing here sells' : ''}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Link
                          to={`/catalogue/products?store=${s.id}`}
                          className="hover:underline"
                          title="Listings set to on sale, of all its listings"
                        >
                          {s.active_product_count} / {s.product_count}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={s.status} label={STATUS_WORDS[s.status]} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(s.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {acting === s.id ? null : (
                          <Button
                            size="sm"
                            variant={s.status === 'active' ? 'outline' : 'default'}
                            onClick={() => setActing(s.id)}
                          >
                            {NEXT[s.status].label}…
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {acting === s.id ? (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={6}>
                          <TransitionForm store={s} onDone={() => setActing(null)} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
          {total > PAGE ? (
            <div className="flex items-center justify-between border-t border-border px-6 py-3 text-sm">
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

/**
 * Open, close or re-open one shop. Closing takes every listing off the
 * storefront at once and stops checkout, so it asks for a reason; the audit
 * trail keeps it.
 */
function TransitionForm({ store, onDone }: { store: AdminStoreRow; onDone: () => void }) {
  const transition = useTransitionAnyStore();
  const [reason, setReason] = useState('');
  const next = NEXT[store.status];
  const closing = next.event === 'suspend';
  const ready = !closing || reason.trim().length >= 3;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    transition.mutate(
      {
        storeId: store.id,
        input: { event: next.event, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 py-1">
      <p className="text-sm">
        {closing
          ? `Closing ${store.display_name} takes all ${store.active_product_count} of its listings off sale and stops checkout. Orders already placed carry on.`
          : store.merchant_status !== 'active'
            ? `The seller is ${(store.merchant_status ?? 'unknown').replace(/_/g, ' ')}, so the shop will open but nothing in it will sell until the seller is approved.`
            : `${store.display_name} will be visible on the storefront and its listings can be bought.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Reason"
          className="h-9 min-w-72 flex-1"
          placeholder={closing ? 'Reason (required)' : 'Reason (optional)'}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant={closing ? 'destructive' : 'default'}
          disabled={transition.isPending || !ready}
        >
          {transition.isPending ? 'Saving…' : next.label}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {transition.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(transition.error)}</p>
      ) : null}
    </form>
  );
}
