import { useEffect, useRef, useState } from 'react';
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
import { apiErrorMessage } from '@installment/web-kit';
import { GHANA_REGIONS, type GhanaRegion } from '@installment/api-types';
import { ImagePlus, Store as StoreIcon } from 'lucide-react';
import {
  useMerchantStore,
  useShopCategories,
  useUpdateMerchantStore,
  useUploadStoreArtwork,
} from '../lib/merchant-api';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

/**
 * The shopfront a buyer actually sees.
 *
 * Everything a merchant may change about it, and nothing they may not: the slug
 * is the storefront's public URL — renaming it breaks every link already shared
 * and every QR code already printed — and going live is a platform transition,
 * not a settings toggle. Both are shown read-only rather than hidden, so a
 * seller can see what their address is and who to ask about it.
 */
export function StorePage() {
  const store = useMerchantStore();

  if (store.isPending) return <LoadingState />;
  if (store.isError) return <ErrorState error={store.error} onRetry={() => void store.refetch()} />;

  return <StoreForm key={store.data.id} />;
}

function StoreForm() {
  const store = useMerchantStore();
  const update = useUpdateMerchantStore();
  const upload = useUploadStoreArtwork();
  const logoInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const s = store.data!;
  const [displayName, setDisplayName] = useState(s.display_name);
  const [about, setAbout] = useState(s.about ?? '');
  const [supportEmail, setSupportEmail] = useState(s.support_email ?? '');
  const [supportPhone, setSupportPhone] = useState(s.support_phone ?? '');
  const [city, setCity] = useState(s.city ?? '');
  const [region, setRegion] = useState(s.region ?? '');
  const categories = useShopCategories();
  // The store row carries the foreign key; the form and the API both speak
  // slugs, so the current value is looked up rather than stored twice.
  const currentCategorySlug =
    (categories.data ?? []).find((c) => c.id === s.primary_category_id)?.slug ?? '';
  const [categorySlug, setCategorySlug] = useState(currentCategorySlug);

  // Re-seed from the server's copy after a save, so the form and the shop agree.
  useEffect(() => {
    setDisplayName(s.display_name);
    setAbout(s.about ?? '');
    setSupportEmail(s.support_email ?? '');
    setSupportPhone(s.support_phone ?? '');
    setCity(s.city ?? '');
    setRegion(s.region ?? '');
  }, [s.display_name, s.about, s.support_email, s.support_phone, s.city, s.region]);

  // Separately, because it also has to wait for the category list to arrive.
  useEffect(() => {
    setCategorySlug(currentCategorySlug);
  }, [currentCategorySlug]);

  const dirty =
    displayName !== s.display_name ||
    about !== (s.about ?? '') ||
    supportEmail !== (s.support_email ?? '') ||
    supportPhone !== (s.support_phone ?? '') ||
    city !== (s.city ?? '') ||
    region !== (s.region ?? '') ||
    categorySlug !== currentCategorySlug;

  async function pickArtwork(file: File | undefined, purpose: 'store_logo' | 'store_banner') {
    if (!file) return;
    setUploadError(null);
    try {
      const key = await upload.mutateAsync({ file, purpose });
      await update.mutateAsync(purpose === 'store_logo' ? { logo_key: key } : { banner_key: key });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : apiErrorMessage(err));
    } finally {
      if (logoInput.current) logoInput.current.value = '';
      if (bannerInput.current) bannerInput.current.value = '';
    }
  }

  function save() {
    update.mutate({
      display_name: displayName.trim(),
      // Empty means "remove it", which the API models as null rather than ''.
      about: about.trim() || undefined,
      support_email: supportEmail.trim() || undefined,
      support_phone: supportPhone.trim() || undefined,
      // These two are nullable on the wire, so an emptied field is `null` and
      // actually clears the column — `undefined` would leave the old value
      // standing and the form would silently disagree with the shopfront.
      city: city.trim() || null,
      region: region ? (region as GhanaRegion) : null,
      ...(categorySlug ? { primary_category_slug: categorySlug } : {}),
    });
  }

  const busy = upload.isPending || update.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your store"
        description="What a shopper sees when they open your shopfront."
        actions={<StatusBadge status={s.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Look</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-hidden rounded-md border border-border">
            {/* Height on the image, not on a grid parent: `h-full` inside a grid
                row that the image itself sizes resolves to auto, so the banner
                rendered at its natural aspect and spilled over the name row
                below it. */}
            <div className="grid place-items-center bg-muted">
              {s.banner_url ? (
                <img src={s.banner_url} alt="" className="h-32 w-full object-cover sm:h-40" />
              ) : (
                <span className="py-12 text-xs text-muted-foreground">No banner yet</span>
              )}
            </div>
            <div className="flex items-center gap-3 p-4">
              <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                {s.logo_url ? (
                  <img src={s.logo_url} alt="" className="size-14 object-cover" />
                ) : (
                  <StoreIcon className="size-5 text-muted-foreground" />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.display_name}</p>
                <p className="truncate text-xs text-muted-foreground">/{s.slug}</p>
              </div>
            </div>
          </div>

          <input
            ref={logoInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => void pickArtwork(e.target.files?.[0], 'store_logo')}
          />
          <input
            ref={bannerInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => void pickArtwork(e.target.files?.[0], 'store_banner')}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => logoInput.current?.click()}
            >
              <ImagePlus />
              {s.logo_url ? 'Replace logo' : 'Add a logo'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => bannerInput.current?.click()}
            >
              <ImagePlus />
              {s.banner_url ? 'Replace banner' : 'Add a banner'}
            </Button>
          </div>
          {uploadError ? <p className="text-sm text-destructive">{uploadError}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="display_name">Store name</Label>
              <Input
                id="display_name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slug">Shopfront address</Label>
              <Input id="slug" value={`/${s.slug}`} readOnly disabled />
              <p className="text-xs text-muted-foreground">
                Fixed — changing it would break links already shared. Ask support if you need it
                changed.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support_email">Support email</Label>
              <Input
                id="support_email"
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="help@yourshop.gh"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support_phone">Support phone</Label>
              <Input
                id="support_phone"
                type="tel"
                value={supportPhone}
                onChange={(e) => setSupportPhone(e.target.value)}
                placeholder="0244 000 000"
                maxLength={20}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="city">Town or market</Label>
              <Input
                id="city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Makola, Accra"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region">Region</Label>
              <select
                id="region"
                className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">Not set</option>
                {GHANA_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Shown on your shopfront. It is the only thing telling a buyer in Kumasi whether you are
            down the road or across the country.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="primary_category">What you mainly sell</Label>
            <select
              id="primary_category"
              className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
              disabled={categories.isPending}
            >
              <option value="">Not set</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Where buyers browsing shops will find you.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="about">About your shop</Label>
            <textarea
              id="about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              rows={4}
              maxLength={5000}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="What you sell, where you are, how long you have been trading."
            />
          </div>

          {update.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(update.error)}</p>
          ) : null}
          <Button size="sm" disabled={!dirty || busy} onClick={save}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
