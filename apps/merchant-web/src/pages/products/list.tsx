import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, StatusBadge } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { ImageOff, Plus } from 'lucide-react';
import { useMerchantProducts } from '../../lib/merchant-api';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const STATUS = [
  { value: '', label: 'All products' },
  { value: 'active', label: 'On sale' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

/**
 * A grid rather than a table, because the thing a seller recognises a product by
 * is its photograph. It is also the one list in this app that reads the same on
 * a counter PC and a phone without hiding columns.
 */
export function ProductsListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const { data, isPending, isError, error, refetch } = useMerchantProducts({
    ...(status ? { status } : {}),
    limit: 60,
  });
  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="What you have listed. A draft is invisible to shoppers until you put it on sale."
        actions={
          <>
            <select
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => navigate('/products/new')}>
              <Plus />
              Add product
            </Button>
          </>
        }
      />

      {isPending ? (
        <Card>
          <LoadingState />
        </Card>
      ) : isError ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            message={
              status
                ? 'No products match this filter.'
                : 'Nothing listed yet. Add your first product.'
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((product) => (
            <Link key={product.id} to={`/products/${product.id}`} className="group">
              <Card className="h-full overflow-hidden transition-colors hover:border-primary/40">
                <div className="grid aspect-[4/3] place-items-center overflow-hidden bg-muted">
                  {product.primary_image_url ? (
                    <img
                      src={product.primary_image_url}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <ImageOff className="size-6 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium group-hover:text-primary">
                      {product.title}
                    </p>
                    <StatusBadge status={product.status} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatGhs(product.base_price_pesewas)}
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
