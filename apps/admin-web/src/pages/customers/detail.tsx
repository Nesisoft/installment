import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
} from '@installment/ui';
import {
  attachGhanaCardSchema,
  rejectGhanaCardSchema,
  setBlocklistSchema,
  setMomoSchema,
  type ConsentType,
  type MomoProvider,
} from '@installment/api-types';
import { ArrowLeft, BadgeCheck, ShieldX } from 'lucide-react';
import {
  useAttachGhanaCard,
  useCustomer,
  useRecordConsent,
  useRemoveBlocklist,
  useSetBlocklist,
  useGhanaCardScan,
  useRejectGhanaCard,
  useSetMomo,
  useVerifyGhanaCard,
} from '../../lib/customers-api';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * The scan the reviewer is being asked to judge.
 *
 * Its absence was the whole problem: the console offered a Verify button beside
 * a card number and no way to see the card, so "verified" meant a reviewer had
 * pressed a button, not that anyone had looked. The API has served this signed
 * link since the private prefix existed — nothing called it.
 */
function GhanaCardScan({ customerId, imageKey }: { customerId: string; imageKey: string }) {
  const scan = useGhanaCardScan(customerId, true);
  // A signed link is minted for any key on the row, whether or not an object
  // was ever written there — so a dead key fails at the <img>, not at the
  // request, and a broken-image glyph beside a Verify button is the same
  // nothing-to-look-at this card exists to stop.
  const [unloadable, setUnloadable] = useState(false);
  const isPdf = imageKey.toLowerCase().endsWith('.pdf');

  if (scan.isPending) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
  if (scan.isError || unloadable) {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        The scan could not be loaded, so there is nothing here to check the details against.
        <span className="mt-1 block break-all font-mono text-xs">{imageKey}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {isPdf ? null : (
        <img
          src={scan.data.url}
          alt="Ghana Card scan"
          onError={() => setUnloadable(true)}
          className="max-h-64 w-full rounded-md border object-contain"
        />
      )}
      {/* noreferrer, so the signed URL does not travel in a Referer header. */}
      <a className="text-sm underline" href={scan.data.url} target="_blank" rel="noreferrer">
        Open the full scan
      </a>
    </div>
  );
}

const CONSENTS: { type: ConsentType; label: string }[] = [
  { type: 'data_processing', label: 'Data processing' },
  { type: 'credit_scoring', label: 'Credit scoring' },
  { type: 'marketing', label: 'Marketing' },
];

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const customer = useCustomer(id);
  const verifyCard = useVerifyGhanaCard(id);
  const attachCard = useAttachGhanaCard(id);
  const rejectCard = useRejectGhanaCard(id);
  const setMomo = useSetMomo(id);
  const recordConsent = useRecordConsent(id);
  const setBlocklist = useSetBlocklist(id);
  const removeBlocklist = useRemoveBlocklist(id);

  const [card, setCard] = useState({ ghana_card_number: '', ghana_card_image_key: '' });
  const [momo, setMomoForm] = useState({ momo_phone: '', momo_provider: 'mtn' as MomoProvider });
  const [rejectReason, setRejectReason] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (customer.isPending) return <LoadingState />;
  if (customer.isError)
    return <ErrorState error={customer.error} onRetry={() => void customer.refetch()} />;

  const c = customer.data;

  function onAttachCard(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = attachGhanaCardSchema.safeParse(card);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the Ghana Card details');
      return;
    }
    attachCard.mutate(parsed.data);
  }

  function onRejectCard(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = rejectGhanaCardSchema.safeParse({ reason: rejectReason });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Say what is wrong with the card');
      return;
    }
    rejectCard.mutate(parsed.data, { onSuccess: () => setRejectReason('') });
  }

  function onSetMomo(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = setMomoSchema.safeParse(momo);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the MoMo details');
      return;
    }
    setMomo.mutate(parsed.data);
  }

  function onBlock(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = setBlocklistSchema.safeParse({ reason: blockReason });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'A reason is required');
      return;
    }
    setBlocklist.mutate(parsed.data, { onSuccess: () => setBlockReason('') });
  }

  return (
    <div className="space-y-6">
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to customers
      </Link>

      <PageHeader
        title={`${c.first_name} ${c.last_name}`}
        description={c.phone}
        actions={
          c.is_on_blocklist ? (
            <StatusBadge status="declined" label="Blocked" />
          ) : (
            <StatusBadge status="active" label="Active" />
          )
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Email" value={c.email} />
            <Field label="Phone" value={c.phone} />
            <Field label="Date of birth" value={formatDate(c.date_of_birth)} />
            <Field label="KYC tier" value={`Tier ${c.kyc_tier}`} />
            <Field
              label="MoMo"
              value={c.momo_phone ? `${c.momo_phone} (${c.momo_provider ?? '—'})` : '—'}
            />
            <Field label="Registered" value={formatDate(c.created_at)} />
          </dl>
        </CardContent>
      </Card>

      {c.is_on_blocklist ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldX className="size-4 text-destructive" />
              Blocklisted
            </CardTitle>
            <CardDescription>{c.blocklist_reason ?? 'No reason recorded.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => removeBlocklist.mutate()}
              disabled={removeBlocklist.isPending}
            >
              {removeBlocklist.isPending ? 'Removing…' : 'Remove from blocklist'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ghana Card</CardTitle>
            <CardDescription>
              {c.ghana_card_number
                ? `${c.ghana_card_number} · ${c.ghana_card_verified ? 'verified' : 'awaiting review'}`
                : 'No Ghana Card on file.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {c.ghana_card_image_key ? (
              // Remount on a re-attach, so a previous key's load failure does not
              // stick to the new scan.
              <GhanaCardScan
                key={c.ghana_card_image_key}
                customerId={id}
                imageKey={c.ghana_card_image_key}
              />
            ) : null}

            {c.ghana_card_verified ? (
              <Badge variant="success">Verified {formatDate(c.ghana_card_verified_at)}</Badge>
            ) : null}

            {c.ghana_card_number ? (
              <form onSubmit={onRejectCard} className="space-y-3">
                {c.ghana_card_verified ? null : (
                  <Button
                    type="button"
                    onClick={() => verifyCard.mutate()}
                    disabled={verifyCard.isPending}
                  >
                    <BadgeCheck />
                    {verifyCard.isPending ? 'Verifying…' : 'Details match the scan — verify'}
                  </Button>
                )}
                <div className="space-y-2">
                  <Label>
                    {c.ghana_card_verified ? 'Withdraw this verification' : 'Reject this card'}
                  </Label>
                  <Input
                    placeholder="Why — unreadable, expired, name does not match…"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="outline" disabled={rejectCard.isPending}>
                  <ShieldX />
                  {rejectCard.isPending
                    ? 'Recording…'
                    : c.ghana_card_verified
                      ? 'Withdraw verification'
                      : 'Reject card'}
                </Button>
              </form>
            ) : null}

            {c.ghana_card_verified ? null : (
              <form onSubmit={onAttachCard} className="space-y-3 border-t pt-4">
                <p className="text-sm text-muted-foreground">
                  {c.ghana_card_number
                    ? 'Replace the card on file — attaching a new scan clears any verification.'
                    : 'Attach the card before it can be reviewed.'}
                </p>
                <div className="space-y-2">
                  <Label>Card number</Label>
                  <Input
                    placeholder="GHA-123456789-0"
                    value={card.ghana_card_number}
                    onChange={(e) => setCard((s) => ({ ...s, ghana_card_number: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Image key (object-storage key)</Label>
                  <Input
                    placeholder="private/kyc/<customer-id>/<uuid>.jpg"
                    value={card.ghana_card_image_key}
                    onChange={(e) =>
                      setCard((s) => ({ ...s, ghana_card_image_key: e.target.value }))
                    }
                  />
                </div>
                <Button type="submit" variant="outline" disabled={attachCard.isPending}>
                  {attachCard.isPending ? 'Attaching…' : 'Attach card'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mobile Money</CardTitle>
            <CardDescription>The account auto-debits use.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSetMomo} className="space-y-3">
              <div className="space-y-2">
                <Label>MoMo phone</Label>
                <Input
                  value={momo.momo_phone}
                  onChange={(e) => setMomoForm((s) => ({ ...s, momo_phone: e.target.value }))}
                  placeholder="024 123 4567"
                />
              </div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <select
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                  value={momo.momo_provider}
                  onChange={(e) =>
                    setMomoForm((s) => ({ ...s, momo_provider: e.target.value as MomoProvider }))
                  }
                >
                  <option value="mtn">MTN</option>
                  <option value="tgo">AirtelTigo</option>
                  <option value="vod">Telecel</option>
                </select>
              </div>
              <Button type="submit" variant="outline" disabled={setMomo.isPending}>
                {setMomo.isPending ? 'Saving…' : 'Save MoMo'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Consents</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {CONSENTS.map(({ type, label }) => {
              const at =
                type === 'data_processing'
                  ? c.data_processing_consent_at
                  : type === 'credit_scoring'
                    ? c.credit_scoring_consent_at
                    : c.marketing_consent_at;
              return (
                <div key={type} className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">{label}</p>
                  {at ? (
                    <p className="mt-1 text-xs text-success">Given {formatDateTime(at)}</p>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => recordConsent.mutate({ type })}
                      disabled={recordConsent.isPending}
                    >
                      Record consent
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {!c.is_on_blocklist ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Blocklist</CardTitle>
            <CardDescription>Prevent this customer from new financing.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onBlock} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label>Reason</Label>
                <Input
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  placeholder="Why is this customer being blocked?"
                />
              </div>
              <Button type="submit" variant="destructive" disabled={setBlocklist.isPending}>
                {setBlocklist.isPending ? 'Blocking…' : 'Add to blocklist'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
    </div>
  );
}
