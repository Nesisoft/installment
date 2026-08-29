import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
} from '@installment/ui';
import { formatGhs, type MerchantProductDetails } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft, ImagePlus, Plus } from 'lucide-react';
import {
  useAddProductImage,
  useAddVariant,
  useMerchantPlanTemplates,
  useMerchantProduct,
  useSetPlanOffers,
  useSetStock,
  useUpdateProduct,
  useUploadProductPhoto,
} from '../../lib/merchant-api';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';
import { parseGhsToPesewas, pesewasToGhsInput } from '../../lib/money';

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const product = useMerchantProduct(id);

  if (product.isPending) return <LoadingState />;
  if (product.isError) {
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }
  const p = product.data;

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
        title={p.title}
        description={formatGhs(p.base_price_pesewas)}
        actions={
          <>
            <StatusBadge status={p.status} />
            <SaleToggle product={p} />
          </>
        }
      />

      <PhotosCard product={p} />
      <DetailsCard product={p} />
      <StockCard product={p} />
      <PlansCard product={p} />
    </div>
  );
}

/**
 * The one control a seller uses most: a draft is invisible to shoppers, and the
 * whole point of the draft state is that putting it on sale is one deliberate
 * click once the photos are up.
 */
function SaleToggle({ product }: { product: MerchantProductDetails }) {
  const update = useUpdateProduct(product.id);
  const onSale = product.status === 'active';

  return (
    <Button
      size="sm"
      variant={onSale ? 'outline' : 'default'}
      disabled={update.isPending || product.status === 'archived'}
      onClick={() => update.mutate({ status: onSale ? 'draft' : 'active' })}
    >
      {onSale ? 'Move to draft' : 'Put on sale'}
    </Button>
  );
}

function PhotosCard({ product }: { product: MerchantProductDetails }) {
  const upload = useUploadProductPhoto();
  const attach = useAddProductImage(product.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      // Two steps: the bytes go straight to storage on a signed URL, and only
      // the key it comes back with is sent to our API. A 6 MB photograph never
      // passes through the API process.
      const key = await upload.mutateAsync(file);
      await attach.mutateAsync({ storage_key: key, position: product.images.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : apiErrorMessage(err));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const busy = upload.isPending || attach.isPending;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Photos</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
          {busy ? 'Uploading…' : 'Add photo'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {product.images.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No photos yet. A listing without one barely sells — add at least one before you put it
            on sale.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {product.images.map((image) => (
              <div
                key={image.id}
                className="grid aspect-square place-items-center overflow-hidden rounded-md border border-border bg-muted"
              >
                {image.url ? (
                  <img
                    src={image.url}
                    alt={image.alt_text ?? ''}
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="p-2 text-center text-[11px] text-muted-foreground">
                    Storage is not configured
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function DetailsCard({ product }: { product: MerchantProductDetails }) {
  const update = useUpdateProduct(product.id);
  const [title, setTitle] = useState(product.title);
  const [price, setPrice] = useState(pesewasToGhsInput(product.base_price_pesewas));
  const [description, setDescription] = useState(product.description ?? '');
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the server's copy changes under us — after a save, or after
  // the sale toggle refetched the product.
  useEffect(() => {
    setTitle(product.title);
    setPrice(pesewasToGhsInput(product.base_price_pesewas));
    setDescription(product.description ?? '');
  }, [product.title, product.base_price_pesewas, product.description]);

  const dirty =
    title !== product.title ||
    price !== pesewasToGhsInput(product.base_price_pesewas) ||
    description !== (product.description ?? '');

  function save() {
    const pesewas = parseGhsToPesewas(price);
    if (pesewas === null) {
      setError('Enter the price in cedis, for example 289.90.');
      return;
    }
    setError(null);
    update.mutate({
      title: title.trim(),
      base_price_pesewas: pesewas,
      description: description.trim() || null,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="p-title">Title</Label>
            <Input
              id="p-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-price">Price (GHS)</Label>
            <Input
              id="p-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-description">Description</Label>
          <textarea
            id="p-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={20_000}
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {update.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(update.error)}</p>
        ) : null}
        <Button size="sm" disabled={!dirty || update.isPending} onClick={save}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </CardContent>
    </Card>
  );
}

function StockCard({ product }: { product: MerchantProductDetails }) {
  const setStock = useSetStock(product.id);
  const addVariant = useAddVariant(product.id);
  const [sku, setSku] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Stock</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <Plus />
          Add a variant
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {product.variants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No variants yet — a product needs at least one before it can be sold.
          </p>
        ) : (
          <div className="space-y-3">
            {product.variants.map((variant) => (
              <StockRow
                key={variant.id}
                sku={variant.sku}
                reserved={variant.inventory?.quantity_reserved ?? 0}
                available={variant.inventory?.quantity_available ?? 0}
                pending={setStock.isPending}
                onSave={(quantity) =>
                  setStock.mutate({ variantId: variant.id, quantity_available: quantity })
                }
              />
            ))}
          </div>
        )}

        {adding ? (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-sku">SKU</Label>
              <Input
                id="new-sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                maxLength={64}
                placeholder="HOT40I-128"
              />
            </div>
            <Button
              size="sm"
              disabled={!sku.trim() || addVariant.isPending}
              onClick={() =>
                addVariant.mutate(
                  { sku: sku.trim(), quantity_available: 0 },
                  {
                    onSuccess: () => {
                      setSku('');
                      setAdding(false);
                    },
                  },
                )
              }
            >
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        ) : null}

        {setStock.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(setStock.error)}</p>
        ) : null}
        {addVariant.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(addVariant.error)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StockRow({
  sku,
  available,
  reserved,
  pending,
  onSave,
}: {
  sku: string;
  available: number;
  reserved: number;
  pending: boolean;
  onSave: (quantity: number) => void;
}) {
  const [value, setValue] = useState(String(available));
  useEffect(() => setValue(String(available)), [available]);

  const quantity = Number(value);
  const valid = Number.isInteger(quantity) && quantity >= 0;
  const dirty = value !== String(available);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{sku}</span>
      {reserved > 0 ? (
        // Reserved stock is held for orders already placed. Showing it stops a
        // seller "correcting" a count that is not wrong.
        <span className="text-xs text-muted-foreground">{reserved} held for orders</span>
      ) : null}
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-24"
        aria-label={`Stock for ${sku}`}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!dirty || !valid || pending}
        onClick={() => onSave(quantity)}
      >
        Save
      </Button>
    </div>
  );
}

function PlansCard({ product }: { product: MerchantProductDetails }) {
  const templates = useMerchantPlanTemplates();
  const setOffers = useSetPlanOffers(product.id);
  const [selected, setSelected] = useState<string[]>(product.plan_template_ids);

  useEffect(() => setSelected(product.plan_template_ids), [product.plan_template_ids]);

  const dirty =
    selected.length !== product.plan_template_ids.length ||
    selected.some((tid) => !product.plan_template_ids.includes(tid));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Instalment plans</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Which plans a shopper may choose for this product. With none selected it can only be
          bought outright.
        </p>
        {templates.isPending ? (
          <LoadingState label="Loading plans…" />
        ) : templates.isError ? (
          <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />
        ) : (
          <div className="space-y-2">
            {/* By name, not by the API's newest-first: this is a checklist a
                seller reads down, and an order that changes whenever the
                platform adds a template moves the box under their cursor. */}
            {[...(templates.data ?? [])]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((template) => (
                <label key={template.id} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-input"
                    checked={selected.includes(template.id)}
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, template.id]
                          : current.filter((tid) => tid !== template.id),
                      )
                    }
                  />
                  <span className="font-medium">{template.name}</span>
                  <span className="text-muted-foreground">
                    {/* number_of_installments excludes the deposit, so a "pay in 4"
                      template carries 3 here. Say it the way the schedule reads. */}
                    {template.down_payment_bps > 0
                      ? `${template.down_payment_bps / 100}% deposit + ${template.number_of_installments} payments`
                      : `${template.number_of_installments} payments`}
                  </span>
                </label>
              ))}
          </div>
        )}
        {setOffers.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(setOffers.error)}</p>
        ) : null}
        <Button
          size="sm"
          disabled={!dirty || setOffers.isPending}
          onClick={() => setOffers.mutate({ plan_template_ids: selected })}
        >
          {setOffers.isPending ? 'Saving…' : 'Save plans'}
        </Button>
      </CardContent>
    </Card>
  );
}
