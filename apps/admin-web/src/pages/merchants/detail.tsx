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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@installment/ui';
import {
  attachPaystackRecipientSchema,
  formatBps,
  formatGhs,
  type MerchantProfile,
  type MerchantStatus,
  type MerchantTransitionEvent,
  type Store,
  type StoreTransitionEvent,
} from '@installment/api-types';
import { apiErrorMessage, useApi } from '@installment/web-kit';
import { ArrowLeft, BadgeCheck, ExternalLink } from 'lucide-react';
import {
  useAttachPaystackRecipient,
  useMerchant,
  useMerchantBalances,
  useMerchantKyc,
  useMerchantKycScan,
  useMerchantPayouts,
  useMerchantReserves,
  useMerchantStore,
  useReviewMerchantKyc,
  useTransitionMerchant,
  useTransitionStore,
  useUpdateMerchantTerms,
  type MerchantKycDocument,
} from '../../lib/merchants-api';
import { describeRates, parseBpsOverride } from '../../lib/terms';
import { formatDate, formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../components/data-states';

const EVENTS_BY_STATUS: Record<MerchantStatus, MerchantTransitionEvent[]> = {
  pending_kyc: ['activate'],
  active: ['suspend', 'offboard'],
  suspended: ['reactivate', 'offboard'],
  offboarded: [],
};
const EVENT_LABEL: Record<MerchantTransitionEvent, string> = {
  activate: 'Activate',
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  offboard: 'Offboard',
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * What this merchant is charged, and the one place staff change it.
 *
 * Reads `fees`, which the API computes with the code that charges it. The
 * Profile card printed `default_mdr_bps` / `default_reserve_bps`, display-only
 * since migration 0009 — so a layaway merchant charged 3% showed 4% — and no
 * screen could enter a deal at all: nothing wrote the override columns.
 */
function TermsCard({ merchant }: { merchant: MerchantProfile }) {
  const update = useUpdateMerchantTerms(merchant.id);
  const [editing, setEditing] = useState(false);
  const [mdr, setMdr] = useState('');
  const [reserve, setReserve] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fees = merchant.fees;

  function startEditing() {
    setMdr(merchant.mdr_bps_override === null ? '' : String(merchant.mdr_bps_override));
    setReserve(merchant.reserve_bps_override === null ? '' : String(merchant.reserve_bps_override));
    setError(null);
    setEditing(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const nextMdr = parseBpsOverride(mdr, 2000);
    if (!nextMdr.ok) return setError(`MDR: ${nextMdr.message}`);
    const nextReserve = parseBpsOverride(reserve, 5000);
    if (!nextReserve.ok) return setError(`Reserve: ${nextReserve.message}`);
    setError(null);
    update.mutate(
      { mdr_bps_override: nextMdr.value, reserve_bps_override: nextReserve.value },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settlement terms</CardTitle>
        <CardDescription>
          A change prices plans activated after it. Plans already running keep the rate frozen onto
          them at activation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fees ? (
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Paid-in-full commission" value={formatBps(fees.pay_now_commission_bps)} />
            <Field label="MDR on a plan" value={describeRates(fees, 'mdr')} />
            <Field label="Reserve on a plan" value={describeRates(fees, 'reserve')} />
          </dl>
        ) : null}
        {editing ? (
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Negotiated MDR (bps)</Label>
              <Input
                inputMode="numeric"
                value={mdr}
                onChange={(e) => setMdr(e.target.value)}
                placeholder="Blank: each plan's own rate"
              />
            </div>
            <div className="space-y-2">
              <Label>Negotiated reserve (bps)</Label>
              <Input
                inputMode="numeric"
                value={reserve}
                onChange={(e) => setReserve(e.target.value)}
                placeholder="Blank: each plan's own rate"
              />
            </div>
            <div className="sm:col-span-2 space-y-2">
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {update.isError ? (
                <p className="text-sm text-destructive">{apiErrorMessage(update.error)}</p>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? 'Saving…' : 'Save terms'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Change terms
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function MerchantDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const merchant = useMerchant(id);
  const balances = useMerchantBalances(id);
  const payouts = useMerchantPayouts(id, { limit: 10 });
  const reserves = useMerchantReserves(id, true);
  const transition = useTransitionMerchant(id);
  const attachRecipient = useAttachPaystackRecipient(id);

  const [reason, setReason] = useState('');
  const [recipient, setRecipient] = useState({
    paystack_recipient_code: '',
    bank_account_number: '',
    bank_code: '',
    bank_account_name: '',
  });
  const [recipientError, setRecipientError] = useState<string | null>(null);

  if (merchant.isPending) return <LoadingState />;
  if (merchant.isError)
    return <ErrorState error={merchant.error} onRetry={() => void merchant.refetch()} />;

  const m = merchant.data;
  const events = EVENTS_BY_STATUS[m.status];

  async function viewStatement() {
    const { data } = await api.get<string>(`/admin/merchants/${id}/statement.html`, {
      responseType: 'text',
    });
    const url = URL.createObjectURL(new Blob([data], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
  }

  function onAttachRecipient(e: FormEvent) {
    e.preventDefault();
    setRecipientError(null);
    const payload = {
      paystack_recipient_code: recipient.paystack_recipient_code,
      ...(recipient.bank_account_number
        ? { bank_account_number: recipient.bank_account_number }
        : {}),
      ...(recipient.bank_code ? { bank_code: recipient.bank_code } : {}),
      ...(recipient.bank_account_name ? { bank_account_name: recipient.bank_account_name } : {}),
    };
    const parsed = attachPaystackRecipientSchema.safeParse(payload);
    if (!parsed.success) {
      setRecipientError(parsed.error.issues[0]?.message ?? 'Check the recipient details');
      return;
    }
    attachRecipient.mutate(parsed.data);
  }

  return (
    <div className="space-y-6">
      <Link
        to="/merchants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to merchants
      </Link>

      <PageHeader
        title={m.business_name}
        description={m.legal_name}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={m.status} />
            <Button variant="outline" size="sm" onClick={() => void viewStatement()}>
              <ExternalLink />
              Statement
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Email" value={m.email} />
            <Field label="Phone" value={m.phone} />
            <Field label="Business model" value={m.default_business_model} />
            <Field label="TIN" value={m.tin ?? '—'} />
            <Field label="Registration no." value={m.registration_number ?? '—'} />
            <Field label="Onboarded" value={formatDate(m.onboarded_at)} />
            {m.suspended_at ? (
              <Field label="Suspended" value={formatDateTime(m.suspended_at)} />
            ) : null}
            {m.suspension_reason ? (
              <Field label="Suspension reason" value={m.suspension_reason} />
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <TermsCard merchant={m} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle</CardTitle>
          <CardDescription>Move the merchant through onboarding and suspension.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No further transitions available.</p>
          ) : (
            <>
              <Input
                placeholder="Reason (optional, required-ish for suspend/offboard)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {events.map((ev) => (
                  <Button
                    key={ev}
                    variant={ev === 'offboard' || ev === 'suspend' ? 'destructive' : 'default'}
                    size="sm"
                    disabled={transition.isPending}
                    onClick={() =>
                      transition.mutate(
                        { event: ev, ...(reason ? { reason } : {}) },
                        { onSuccess: () => setReason('') },
                      )
                    }
                  >
                    {EVENT_LABEL[ev]}
                  </Button>
                ))}
              </div>
            </>
          )}
          {transition.isError ? (
            <p className="text-sm text-destructive">{apiErrorMessage(transition.error)}</p>
          ) : null}
        </CardContent>
      </Card>

      <KycCard merchantId={id} />

      <ShopfrontCard merchantId={id} merchantStatus={m.status as MerchantStatus} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settlement balances</CardTitle>
        </CardHeader>
        <CardContent>
          {balances.isPending ? (
            <LoadingState label="Loading balances…" />
          ) : balances.isError ? (
            <ErrorState error={balances.error} onRetry={() => void balances.refetch()} />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Payable" value={formatGhs(balances.data.payablePesewas)} />
              <Field label="Reserve held" value={formatGhs(balances.data.reserveHeldPesewas)} />
              <Field
                label="Lifetime settled"
                value={formatGhs(balances.data.lifetimeSettledPesewas)}
              />
              <Field label="Open reserves" value={String(balances.data.openReservesCount)} />
              <Field label="Active plans" value={String(balances.data.activePlans)} />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paystack recipient</CardTitle>
          <CardDescription>
            {m.paystack_recipient_code
              ? `Current: ${m.paystack_recipient_code}${m.bank_account_name ? ` · ${m.bank_account_name}` : ''}`
              : 'No payout recipient attached yet — settlements cannot run without one.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAttachRecipient} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Recipient code</Label>
              <Input
                value={recipient.paystack_recipient_code}
                onChange={(e) =>
                  setRecipient((r) => ({ ...r, paystack_recipient_code: e.target.value }))
                }
                placeholder="RCP_xxx"
              />
            </div>
            <div className="space-y-2">
              <Label>Bank account name</Label>
              <Input
                value={recipient.bank_account_name}
                onChange={(e) => setRecipient((r) => ({ ...r, bank_account_name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Bank account number</Label>
              <Input
                value={recipient.bank_account_number}
                onChange={(e) =>
                  setRecipient((r) => ({ ...r, bank_account_number: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Bank code</Label>
              <Input
                value={recipient.bank_code}
                onChange={(e) => setRecipient((r) => ({ ...r, bank_code: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2 space-y-2">
              {recipientError ? <p className="text-sm text-destructive">{recipientError}</p> : null}
              {attachRecipient.isError ? (
                <p className="text-sm text-destructive">{apiErrorMessage(attachRecipient.error)}</p>
              ) : null}
              {attachRecipient.isSuccess ? (
                <p className="text-sm text-success">Recipient saved.</p>
              ) : null}
              <Button type="submit" disabled={attachRecipient.isPending}>
                {attachRecipient.isPending ? 'Saving…' : 'Save recipient'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent payouts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {payouts.isPending ? (
            <LoadingState label="Loading payouts…" />
          ) : payouts.isError ? (
            <ErrorState error={payouts.error} onRetry={() => void payouts.refetch()} />
          ) : payouts.data.rows.length === 0 ? (
            <EmptyState message="No payouts yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>As of</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Settled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.data.rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                    <TableCell>{formatDate(p.asOfDate)}</TableCell>
                    <TableCell>{formatGhs(p.amountPesewas)}</TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(p.settledAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open reserves</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reserves.isPending ? (
            <LoadingState label="Loading reserves…" />
          ) : reserves.isError ? (
            <ErrorState error={reserves.error} onRetry={() => void reserves.refetch()} />
          ) : reserves.data.length === 0 ? (
            <EmptyState message="No open reserves." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Held</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Releasable from</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reserves.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.businessModel}</TableCell>
                    <TableCell>{formatGhs(r.amountPesewas)}</TableCell>
                    <TableCell>{formatGhs(r.outstandingPesewas)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r.releasableFrom)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const STORE_EVENTS: Record<string, StoreTransitionEvent[]> = {
  draft: ['activate'],
  active: ['suspend'],
  suspended: ['unsuspend'],
};
const STORE_EVENT_LABEL: Record<StoreTransitionEvent, string> = {
  activate: 'Open the shop',
  suspend: 'Close the shop',
  unsuspend: 'Re-open the shop',
};

/**
 * The merchant's shopfront, and the button that opens it.
 *
 * A merchant and their store are separate rows with separate lifecycles, and
 * since the seller-liveness fix BOTH must be `active` before anything sells —
 * the storefront and checkout each check both. Self-signup creates the store as
 * `draft`, so activating the business alone leaves a shop nobody can buy from,
 * and there was no way to open one from any admin screen at all.
 *
 * It lives on the merchant page rather than a stores section because that is
 * where the review happens: one screen, one decision, both transitions.
 */
const DOC_LABELS: Record<string, string> = {
  ghana_card_front: 'Ghana Card · front',
  ghana_card_back: 'Ghana Card · back',
  shop_photo: 'Shop or stall photo',
  business_registration: 'Business registration',
};

/**
 * The document a reviewer is being asked to judge.
 *
 * Shown before the decision, for the same reason the customer Ghana Card is
 * (#64): a Verify button beside a filename records that somebody pressed a
 * button, not that anybody looked. A signed link is minted for any key on the
 * row whether or not bytes were ever written there, so a dead key fails at the
 * <img> and has to degrade to something a reviewer can read.
 */
function KycScan({ merchantId, documentId }: { merchantId: string; documentId: string }) {
  const scan = useMerchantKycScan(merchantId, documentId);
  const [unloadable, setUnloadable] = useState(false);

  if (scan.isPending) return <div className="h-32 animate-pulse rounded-md bg-muted" />;
  if (scan.isError || unloadable) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        The document could not be loaded, so there is nothing here to check against.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <img
        src={scan.data.url}
        alt="KYC document"
        onError={() => setUnloadable(true)}
        className="max-h-56 w-full rounded-md border object-contain"
      />
      {/* noreferrer, so the signed URL does not travel in a Referer header. */}
      <a className="text-xs underline" href={scan.data.url} target="_blank" rel="noreferrer">
        Open the full document
      </a>
    </div>
  );
}

function KycDocumentRow({ merchantId, doc }: { merchantId: string; doc: MerchantKycDocument }) {
  const review = useReviewMerchantKyc(merchantId);
  const [reason, setReason] = useState('');
  const decided = doc.status !== 'submitted';

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{DOC_LABELS[doc.doc_type] ?? doc.doc_type}</p>
          <p className="text-xs text-muted-foreground">
            Sent {formatDateTime(doc.created_at)}
            {doc.rejection_reason ? ` · rejected: ${doc.rejection_reason}` : ''}
          </p>
        </div>
        <Badge
          variant={
            doc.status === 'approved' ? 'success' : doc.status === 'rejected' ? 'danger' : 'warning'
          }
        >
          {doc.status}
        </Badge>
      </div>

      <KycScan merchantId={merchantId} documentId={doc.id} />

      {decided ? null : (
        <div className="space-y-2">
          <Button
            size="sm"
            onClick={() => review.mutate({ documentId: doc.id })}
            disabled={review.isPending}
          >
            <BadgeCheck />
            {review.isPending ? 'Saving…' : 'Matches — approve'}
          </Button>
          <Input
            placeholder="Or say what is wrong with it…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending || reason.trim().length === 0}
            onClick={() => review.mutate({ documentId: doc.id, reason: reason.trim() })}
          >
            Reject
          </Button>
        </div>
      )}
      {review.isError ? (
        <p className="text-xs text-destructive">{apiErrorMessage(review.error)}</p>
      ) : null}
    </div>
  );
}

/**
 * Merchant KYC, and the reason Activate may be refused.
 *
 * Placed above the shopfront card because it comes first in the real sequence:
 * a merchant cannot be activated until the required documents are approved, and
 * their store cannot open until the merchant is active.
 */
function KycCard({ merchantId }: { merchantId: string }) {
  const kyc = useMerchantKyc(merchantId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">KYC documents</CardTitle>
        <CardDescription>
          {kyc.data?.complete
            ? 'Everything required has been approved.'
            : kyc.data
              ? `Outstanding: ${kyc.data.outstanding.map((t) => DOC_LABELS[t] ?? t).join(', ')}`
              : 'Loading…'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {kyc.isPending ? <LoadingState /> : null}
        {kyc.isError ? <ErrorState error={kyc.error} onRetry={() => void kyc.refetch()} /> : null}

        {kyc.data?.exempt ? (
          <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
            This merchant was already trading before document review existed, so activation does not
            require these. Their original activation was not evidenced.
          </p>
        ) : null}

        {kyc.data && kyc.data.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing submitted yet. The merchant sends these from their own app; activation is
            refused until the required ones are approved.
          </p>
        ) : null}

        {kyc.data?.documents.map((doc) => (
          <KycDocumentRow key={doc.id} merchantId={merchantId} doc={doc} />
        ))}
      </CardContent>
    </Card>
  );
}

function ShopfrontCard({
  merchantId,
  merchantStatus,
}: {
  merchantId: string;
  merchantStatus: MerchantStatus;
}) {
  const store = useMerchantStore(merchantId);
  const [reason, setReason] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shopfront</CardTitle>
        <CardDescription>
          Both the merchant and the shop must be active before anything can be sold.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {store.isPending ? (
          <LoadingState label="Loading the shop…" />
        ) : store.isError ? (
          <ErrorState error={store.error} onRetry={() => void store.refetch()} />
        ) : !store.data ? (
          <EmptyState message="This merchant has no shopfront. Create one before activating them." />
        ) : (
          <StoreActions
            store={store.data}
            merchantId={merchantId}
            merchantStatus={merchantStatus}
            reason={reason}
            onReason={setReason}
          />
        )}
      </CardContent>
    </Card>
  );
}

function StoreActions({
  store,
  merchantId,
  merchantStatus,
  reason,
  onReason,
}: {
  store: Store;
  merchantId: string;
  merchantStatus: MerchantStatus;
  reason: string;
  onReason: (value: string) => void;
}) {
  const transition = useTransitionStore(store.id, merchantId);
  const events = STORE_EVENTS[store.status] ?? [];

  return (
    <>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Shop name" value={store.display_name} />
        <Field label="Address" value={`/${store.slug}`} />
        <Field label="Shop status" value={store.status} />
        <Field label="Created" value={formatDate(store.created_at)} />
      </dl>

      {/* Said plainly, because activating one and not the other is the mistake
          this card exists to prevent. */}
      {store.status === 'active' && merchantStatus !== 'active' ? (
        <p className="text-sm text-warning-foreground">
          The shop is open but the merchant is {merchantStatus} — nothing will sell until the
          merchant is active too.
        </p>
      ) : null}
      {store.status !== 'active' && merchantStatus === 'active' ? (
        <p className="text-sm text-warning-foreground">
          The merchant is active but the shop is {store.status} — nothing will sell until the shop
          is open.
        </p>
      ) : null}

      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No further shop transitions available.</p>
      ) : (
        <>
          <Input
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => onReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {events.map((ev) => (
              <Button
                key={ev}
                variant={ev === 'suspend' ? 'destructive' : 'default'}
                size="sm"
                disabled={transition.isPending}
                onClick={() =>
                  transition.mutate(
                    { event: ev, ...(reason ? { reason } : {}) },
                    { onSuccess: () => onReason('') },
                  )
                }
              >
                {STORE_EVENT_LABEL[ev]}
              </Button>
            ))}
          </div>
        </>
      )}
      {transition.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(transition.error)}</p>
      ) : null}
    </>
  );
}
