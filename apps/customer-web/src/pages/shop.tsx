import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, CardContent, Input, Skeleton } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { Search } from 'lucide-react';
import { useCategories, useProductSearch } from '../lib/shop-api';
import { EmptyState, ErrorState } from '../components/data-states';

export function ShopPage() {
  const [term, setTerm] = useState('');
  const categories = useCategories(true);
  const results = useProductSearch(term);
  const searching = term.trim().length > 0;

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

      {!searching ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Browse categories</h2>
          {categories.isPending ? (
            <div className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : categories.isError ? (
            <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
          ) : (categories.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No categories yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {(categories.data ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setTerm(c.name)}
                    className="rounded-lg border border-border bg-card p-4 text-left text-sm font-medium transition-colors hover:border-primary/40"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Tap a category to search it, or type what you are looking for.
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Results for “{term.trim()}”</h2>
          {results.isPending ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : results.isError ? (
            <ErrorState error={results.error} onRetry={() => void results.refetch()} />
          ) : (results.data ?? []).length === 0 ? (
            <EmptyState message="Nothing matched that search." />
          ) : (
            <ul className="space-y-3">
              {(results.data ?? []).map((p) => (
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
          )}
        </section>
      )}
    </div>
  );
}
