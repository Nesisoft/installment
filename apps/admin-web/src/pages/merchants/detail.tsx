import { useState, type FormEvent } from 'react';
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
import {
  attachPaystackRecipientSchema,
  formatBps,
  formatGhs,
  type MerchantStatus,
  type MerchantTransitionEvent,
} from '@installment/api-types';
import { apiErrorMessage, useApi } from '@installment/web-kit';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  useAttachPaystackRecipient,
  useMerchant,
  useMerchantBalances,
  useMerchantPayouts,
  useMerchantReserves,
  useTransitionMerchant,
} from '../../lib/merchants-api';
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
            <Field label="MDR" value={formatBps(m.default_mdr_bps)} />
            <Field label="Reserve" value={formatBps(m.default_reserve_bps)} />
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
