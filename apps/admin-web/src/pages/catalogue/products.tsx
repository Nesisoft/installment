import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { formatGhs, type ProductStatus } from '@installment/api-types';
import { ImageOff } from 'lucide-react';
import { useAdminProductCounts, useAdminProducts } from '../../lib/catalogue-api';
import { formatDate } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const PAGE = 50;

type Filter = ProductStatus | 'taken_down' | '';

const FILTERS: { value: Filter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'On sale' },
  { value: 'draft', label: 'Off sale' },
  { value: 'archived', label: 'Retired' },
  { value: 'taken_down', label: 'Taken down' },
];

export function ProductsListPage() {
  const navigate = useNavigate();
  // Arrived from a shop's listing count on the shops page.
  const [params, setParams] = useSearchParams();
  const storeId = params.get('store') ?? '';
  const [filter, setFilter] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);

  const counts = useAdminProductCounts();
  const list = useAdminProducts({
    ...(filter === 'taken_down' ? { taken_down: true } : filter ? { status: filter } : {}),
    ...(q ? { q } : {}),
    ...(storeId ? { store_id: storeId } : {}),
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
        title="Listings"
        description="Every seller's products. Open one to see it as a buyer would, or take it down."
        actions={
          <form onSubmit={onSearch} className="flex gap-2">
            <Input
              aria-label="Search titles"
              placeholder="Search titles"
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

      {storeId ? (
        <div className="flex items-center gap-3 text-sm">
          <span>
            Showing one shop
            {rows[0]?.store_name ? (
              <>
                : <strong>{rows[0].store_name}</strong>
              </>
            ) : null}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setParams({});
              setPage(0);
            }}
          >
            Show every shop
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((f) => {
          // The counts are marketplace-wide, so they would mislead beside one shop.
          const n = counts.data && !storeId ? counts.data[f.value || 'all'] : undefined;
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
            <EmptyState message="No listings match." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16" />
                  <TableHead>Listing</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">In stock</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/catalogue/products/${p.id}`)}
                  >
                    <TableCell>
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt=""
                          className="size-12 rounded-md border border-border object-cover"
                        />
                      ) : (
                        <div className="grid size-12 place-items-center rounded-md border border-border bg-muted">
                          <ImageOff className="size-4 text-muted-foreground" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{p.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.category_name ?? 'No category'} · {p.variant_count}{' '}
                        {p.variant_count === 1 ? 'variant' : 'variants'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{p.store_name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{p.merchant_name ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGhs(p.base_price_pesewas)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.units_available}</TableCell>
                    <TableCell>
                      {p.taken_down_at ? (
                        <StatusBadge status="taken_down" tone="danger" label="Taken down" />
                      ) : (
                        <StatusBadge status={p.status} />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(p.updated_at)}
                    </TableCell>
                  </TableRow>
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
