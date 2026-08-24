import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, CardContent, Input, Skeleton, cn } from '@installment/ui';
import { formatGhs, type Product } from '@installment/api-types';
import { Search, X } from 'lucide-react';
import { useCategories, useProductSearch, useProducts } from '../lib/shop-api';
import { EmptyState, ErrorState } from '../components/data-states';

function ProductList({ products }: { products: Product[] }) {
  return (
    <ul className="space-y-3">
      {products.map((p) => (
        <li key={p.id}>
          <Link to={`/products/${p.id}`}>
            <Card className="transition-colors hover:border-primary/40">
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.title}</p>
                  {p.description ? (
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  ) : null}
                </div>
                <Badge variant="default" className="shrink-0">
                  {formatGhs(p.base_price_pesewas)}
                </Badge>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20" />
      ))}
    </div>
  );
}

export function ShopPage() {
  const [term, setTerm] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const categories = useCategories(true);
  const results = useProductSearch(term);
  // Browsing is the default view; searching takes over while there is a term.
  const browse = useProducts(categoryId ? { category_id: categoryId } : {});

  const searching = term.trim().length > 0;
  const activeCategory = (categories.data ?? []).find((c) => c.id === categoryId) ?? null;

  return (
    <div className="space-y-5">
      <section className="rounded-lg bg-primary p-5 text-primary-foreground shadow-sm">
        <p className="text-sm text-primary-foreground/80">Shop now, pay later</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">What do you need?</p>
        <p className="mt-2 text-sm text-primary-foreground/80">
          Spread the cost over weekly or monthly instalments.
        </p>
      </section>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search products…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search products"
        />
      </div>

      {searching ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Results for “{term.trim()}”</h2>
          {results.isPending ? (
            <ListSkeleton />
          ) : results.isError ? (
            <ErrorState error={results.error} onRetry={() => void results.refetch()} />
          ) : (results.data ?? []).length === 0 ? (
            <EmptyState message="Nothing matched that search." />
          ) : (
            <ProductList products={results.data ?? []} />
          )}
        </section>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Categories</h2>
            {categories.isPending ? (
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-9 w-24" />
                ))}
              </div>
            ) : categories.isError ? (
              <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {(categories.data ?? []).map((c) => {
                  const active = categoryId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCategoryId(active ? null : c.id)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input bg-card text-foreground hover:border-primary/40',
                      )}
                    >
                      {c.name}
                      {active ? <X className="size-3.5" /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              {activeCategory ? activeCategory.name : 'All products'}
            </h2>
            {browse.isPending ? (
              <ListSkeleton />
            ) : browse.isError ? (
              <ErrorState error={browse.error} onRetry={() => void browse.refetch()} />
            ) : (browse.data ?? []).length === 0 ? (
              <EmptyState
                message={
                  activeCategory
                    ? `Nothing in ${activeCategory.name} yet.`
                    : 'No products available yet.'
                }
              />
            ) : (
              <ProductList products={browse.data ?? []} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
