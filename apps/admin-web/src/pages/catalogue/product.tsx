import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { ArrowLeft, ImageOff } from 'lucide-react';
import { useAdminProduct, useLiftTakedown, useTakeDownProduct } from '../../lib/catalogue-api';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

const STATUS_WORDS: Record<string, string> = {
  active: 'On sale',
  draft: 'Off sale',
  archived: 'Retired',
};

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const product = useAdminProduct(id);
  const takeDown = useTakeDownProduct(id);
  const lift = useLiftTakedown(id);
  const [reason, setReason] = useState('');
  const [confirmingLift, setConfirmingLift] = useState(false);

  if (product.isPending) return <LoadingState />;
  if (product.isError) {
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }
  const p = product.data;

  function onTakeDown(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    takeDown.mutate({ reason: reason.trim() }, { onSuccess: () => setReason('') });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/catalogue/products"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Listings
      </Link>

      <PageHeader
        title={p.title}
        description={`${formatGhs(p.base_price_pesewas)} · ${p.store?.display_name ?? 'Unknown shop'} · listed ${formatDate(p.created_at)}`}
        actions={
          p.taken_down_at ? (
            <StatusBadge status="taken_down" tone="danger" label="Taken down" />
          ) : (
            <StatusBadge status={p.status} label={STATUS_WORDS[p.status] ?? p.status} />
          )
        }
      />

      {p.taken_down_at ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Taken down</CardTitle>
            <CardDescription>
              {formatDateTime(p.taken_down_at)}. The seller sees this reason and cannot put the
              listing back on sale; they can still edit it. Lifting the takedown returns it to{' '}
              {STATUS_WORDS[p.taken_down_from_status ?? 'archived']?.toLowerCase() ?? 'its status'}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="rounded-md bg-muted px-4 py-3 text-sm">{p.taken_down_reason}</p>
            {confirmingLift ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">
                  Lift the takedown and put this back as{' '}
                  {STATUS_WORDS[p.taken_down_from_status ?? 'archived']?.toLowerCase()}?
                </span>
                <Button
                  disabled={lift.isPending}
                  onClick={() =>
                    lift.mutate(undefined, { onSuccess: () => setConfirmingLift(false) })
                  }
                >
                  {lift.isPending ? 'Lifting…' : 'Lift takedown'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingLift(false)}>
                  Keep it down
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => setConfirmingLift(true)}>
                Lift takedown…
              </Button>
            )}
            {lift.isError ? (
              <p className="text-sm text-destructive">{apiErrorMessage(lift.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Photos</CardTitle>
        </CardHeader>
        <CardContent>
          {p.images.length === 0 ? (
            <p className="text-sm text-muted-foreground">No photos.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {p.images.map((img) =>
                img.url ? (
                  <a key={img.id} href={img.url} target="_blank" rel="noreferrer">
                    <img
                      src={img.url}
                      alt={img.alt_text ?? ''}
                      className="size-32 rounded-md border border-border object-cover"
                    />
                  </a>
                ) : (
                  <div
                    key={img.id}
                    className="grid size-32 place-items-center rounded-md border border-border bg-muted"
                    title={img.storage_key}
                  >
                    <ImageOff className="size-5 text-muted-foreground" />
                  </div>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Listing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Shop"
              value={
                p.store ? (
                  <span>
                    {p.store.display_name}{' '}
                    <span className="text-xs text-muted-foreground">({p.store.status})</span>
                  </span>
                ) : (
                  '—'
                )
              }
            />
            <Field
              label="Seller"
              value={
                p.merchant ? (
                  <Link to={`/merchants/${p.merchant.id}`} className="text-primary hover:underline">
                    {p.merchant.business_name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Field label="Category" value={p.category?.name ?? 'None'} />
            <Field label="Price" value={formatGhs(p.base_price_pesewas)} />
            <Field
              label="Was price"
              value={p.compare_at_price_pesewas ? formatGhs(p.compare_at_price_pesewas) : '—'}
            />
            <Field label="Sale ends" value={formatDateTime(p.deal_ends_at)} />
            <Field label="Instalment plans offered" value={String(p.plan_template_ids.length)} />
            <Field label="Last changed" value={formatDateTime(p.updated_at)} />
          </dl>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Description</div>
            <p className="mt-1 whitespace-pre-wrap text-sm">{p.description || '—'}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Variants and stock</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Options</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.variants.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {Object.entries(v.option_values ?? {})
                      .map(([k, val]) => `${k}: ${String(val)}`)
                      .join(', ') || '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatGhs(v.price_pesewas ?? p.base_price_pesewas)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.inventory?.quantity_available ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.inventory?.quantity_reserved ?? 0}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {!p.taken_down_at ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Take down</CardTitle>
            <CardDescription>
              For a listing that breaks the rules — counterfeit, prohibited, misleading. It comes
              off sale at once and stays off: the seller can edit it, but not publish it, until the
              takedown is lifted. They see the reason you give, so write it for them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onTakeDown} className="flex flex-wrap items-end gap-3">
              <div className="min-w-72 flex-1 space-y-2">
                <Label htmlFor="takedown-reason">Reason, for the seller</Label>
                <Input
                  id="takedown-reason"
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="e.g. Branded goods need proof they are genuine"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={takeDown.isPending || reason.trim().length < 3}
              >
                {takeDown.isPending ? 'Taking down…' : 'Take down'}
              </Button>
            </form>
            {takeDown.isError ? (
              <p className="mt-3 text-sm text-destructive">{apiErrorMessage(takeDown.error)}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
