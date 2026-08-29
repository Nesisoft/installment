import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@installment/ui';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft } from 'lucide-react';
import { useCreateProduct, useMerchantStore } from '../../lib/merchant-api';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';
import { parseGhsToPesewas } from '../../lib/money';

/**
 * Deliberately short. A seller adding their first product should not meet a
 * twelve-field form — title, price, one SKU and a stock count is enough to have
 * something real, and photos, variants and instalment plans are all added on
 * the product's own page afterwards.
 *
 * It creates a `draft`, so nothing half-finished appears in the shop while the
 * photographs are still being uploaded.
 */
export function NewProductPage() {
  const navigate = useNavigate();
  const store = useMerchantStore();
  const create = useCreateProduct();

  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [sku, setSku] = useState('');
  const [stock, setStock] = useState('0');
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const pesewas = parseGhsToPesewas(price);
    if (pesewas === null) {
      setFormError('Enter the price in cedis, for example 289.90.');
      return;
    }
    if (!title.trim()) {
      setFormError('Give the product a title.');
      return;
    }
    setFormError(null);

    const quantity = Number(stock);
    const product = await create.mutateAsync({
      title: title.trim(),
      base_price_pesewas: pesewas,
      status: 'draft',
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(sku.trim()
        ? {
            variants: [
              {
                sku: sku.trim(),
                ...(Number.isInteger(quantity) && quantity >= 0
                  ? { quantity_available: quantity }
                  : {}),
              },
            ],
          }
        : {}),
    });
    navigate(`/products/${product.id}`);
  }

  if (store.isPending) return <LoadingState />;
  if (store.isError) {
    // The only way here is a merchant with no store row, which is a setup
    // problem rather than something a retry fixes — so say what is wrong.
    return (
      <ErrorState
        error={store.error}
        onRetry={() => {
          void store.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/products"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to products
      </Link>

      <PageHeader
        title="Add a product"
        description={`It will be saved as a draft in ${store.data.display_name} — add photos, then put it on sale.`}
      />

      <form onSubmit={(e) => void submit(e)}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Infinix Hot 40i, 256GB"
                maxLength={300}
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="price">Price (GHS)</Label>
                <Input
                  id="price"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="1200.00"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="HOT40I-256"
                  maxLength={64}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="stock">How many do you have?</Label>
              <Input
                id="stock"
                type="number"
                min={0}
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className="sm:max-w-40"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={20_000}
                className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="What it is, what comes in the box, anything a buyer should know."
              />
            </div>

            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            {create.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(create.error)}</p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Save as draft'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate('/products')}
                disabled={create.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
