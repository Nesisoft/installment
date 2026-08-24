import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { apiErrorMessage, useAuth } from '@installment/web-kit';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { useAddToCart, usePlanTemplates, useProduct } from '../lib/shop-api';
import { cadenceLabel, isEligible, previewPlan } from '../lib/installment-preview';
import { ErrorState, LoadingState } from '../components/data-states';

export function ProductPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const product = useProduct(id);
  const templates = usePlanTemplates();
  const addToCart = useAddToCart();
  const [variantId, setVariantId] = useState<string | null>(null);

  const p = product.data;
  const variants = useMemo(() => (p?.variants ?? []).filter((v) => v.is_active), [p]);
  const selected = variants.find((v) => v.id === variantId) ?? variants[0] ?? null;
  const price = selected?.price_pesewas ?? p?.base_price_pesewas ?? 0;
  const inStock = (selected?.inventory?.quantity_available ?? 0) > 0;

  /** Offers for this product that also fit the price. Cheapest instalment first. */
  const offers = useMemo(() => {
    if (!p || !templates.data) return [];
    const offered = new Set(p.plan_template_ids);
    return templates.data
      .filter((t) => offered.has(t.id) && isEligible(t, price))
      .map((t) => ({ template: t, preview: previewPlan(t, price) }))
      .sort((a, b) => a.preview.perInstallmentPesewas - b.preview.perInstallmentPesewas);
  }, [p, templates.data, price]);

  if (product.isPending) return <LoadingState />;
  if (product.isError)
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  if (!p) return null;

  const cheapest = offers[0];

  const onAdd = () => {
    if (!selected) return;
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    addToCart.mutate(
      { variant_id: selected.id, quantity: 1 },
      { onSuccess: () => navigate('/cart') },
    );
  };

  return (
    <div className="space-y-5">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to shop
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{p.title}</h1>
        <p className="mt-1 text-2xl font-semibold text-primary">{formatGhs(price)}</p>
        {cheapest ? (
          <p className="mt-1 text-sm text-muted-foreground">
            or about{' '}
            <span className="font-medium text-foreground">
              {formatGhs(cheapest.preview.perInstallmentPesewas)}
            </span>{' '}
            / {cadenceLabel(cheapest.preview.frequencyDays)}
          </p>
        ) : null}
      </div>

      {p.description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{p.description}</p>
      ) : null}

      {variants.length > 1 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Choose an option</h2>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => {
              const label =
                Object.values(v.option_values ?? {})
                  .map((x) => String(x))
                  .join(' · ') || v.sku;
              const active = selected?.id === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariantId(v.id)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm transition-colors',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input bg-card text-foreground hover:border-primary/40',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {offers.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pay in instalments</CardTitle>
            <CardDescription>
              Estimated — your exact schedule is confirmed at checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {offers.map(({ template, preview }) => (
              <div
                key={template.id}
                className="flex items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{template.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {preview.installments} payments every {cadenceLabel(preview.frequencyDays)}
                    {preview.downPaymentPesewas > 0
                      ? ` · ${formatGhs(preview.downPaymentPesewas)} upfront`
                      : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold">
                    {formatGhs(preview.perInstallmentPesewas)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    / {cadenceLabel(preview.frequencyDays)}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        {selected ? (
          <Badge variant={inStock ? 'success' : 'muted'}>
            {inStock ? 'In stock' : 'Out of stock'}
          </Badge>
        ) : null}
        {addToCart.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(addToCart.error)}</p>
        ) : null}
        <Button
          className="w-full"
          size="lg"
          disabled={!selected || !inStock || addToCart.isPending}
          onClick={onAdd}
        >
          <ShoppingCart />
          {addToCart.isPending ? 'Adding…' : isAuthenticated ? 'Add to cart' : 'Sign in to buy'}
        </Button>
      </div>
    </div>
  );
}
