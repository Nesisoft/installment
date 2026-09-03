import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@installment/ui';
import { apiErrorMessage } from '@installment/web-kit';
import { BadgeCheck, TriangleAlert, Upload } from 'lucide-react';
import {
  useMerchantKyc,
  useMerchantProfile,
  useSubmitKycDocument,
  type MerchantKycDocType,
  type MerchantKycDocument,
} from '../lib/merchant-api';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/page-header';
import { ErrorState, LoadingState } from '../components/data-states';

/**
 * What a merchant has to send before they can trade.
 *
 * This is the step that had no home. A merchant could sign themselves up, open
 * a store, list products — and then wait, because leaving `pending_kyc` was an
 * admin pressing Activate with no document anywhere in the system to have
 * looked at. That activation is now refused until the required documents here
 * are approved, which makes this page the thing that unblocks a new shop.
 */

const DOCS: { type: MerchantKycDocType; label: string; hint: string; required: boolean }[] = [
  {
    type: 'ghana_card_front',
    label: 'Ghana Card · front',
    hint: 'The side with your photograph and card number.',
    required: true,
  },
  {
    type: 'ghana_card_back',
    label: 'Ghana Card · back',
    hint: 'Both sides are needed to check the card is genuine.',
    required: true,
  },
  {
    type: 'shop_photo',
    label: 'Shop or stall photo',
    hint: 'One clear photo of where you sell from.',
    required: true,
  },
  {
    type: 'business_registration',
    label: 'Business registration',
    hint: 'Optional. Send it if you are a registered company.',
    required: false,
  },
];

export function KycPage() {
  const kyc = useMerchantKyc();
  const profile = useMerchantProfile();

  if (kyc.isPending) return <LoadingState />;
  if (kyc.isError) return <ErrorState error={kyc.error} onRetry={() => void kyc.refetch()} />;

  const status = kyc.data;
  const byType = new Map(status.documents.map((d) => [d.doc_type, d] as const));
  const merchantStatus = profile.data?.status;

  // Three states, not two. `complete` means every required document has been
  // APPROVED, which is a fact about our queue, not about the merchant's — a
  // merchant who has just sent all three has nothing left to do, and telling
  // them we are "waiting on your documents" reads as a request they cannot act
  // on. What matters to them is whether anything is theirs to send.
  const REQUIRED = DOCS.filter((d) => d.required).map((d) => d.type);
  const theirsToSend = REQUIRED.filter(
    (t) => (byType.get(t)?.status ?? 'missing') === 'missing',
  ).concat(REQUIRED.filter((t) => byType.get(t)?.status === 'rejected')).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Verification"
        description="Who you are and where you sell from, checked before your shop can trade."
      />

      {merchantStatus === 'active' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="size-4 text-success" />
              Verified — your shop can trade
            </CardTitle>
          </CardHeader>
        </Card>
      ) : (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-warning" />
              {theirsToSend > 0 ? 'Waiting on your documents' : 'With our team for a check'}
            </CardTitle>
            <CardDescription>
              {theirsToSend > 0
                ? 'Your shop cannot take orders until these have been checked. Photos taken on a phone are fine — just make sure every corner of the card is in frame.'
                : status.complete
                  ? 'Everything we asked for has been approved. Someone will open your shop shortly.'
                  : 'Nothing left for you to send. We will let you know if anything needs re-taking.'}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {DOCS.map((doc) => (
        <DocumentCard key={doc.type} spec={doc} document={byType.get(doc.type)} />
      ))}
    </div>
  );
}

function DocumentCard({
  spec,
  document,
}: {
  spec: (typeof DOCS)[number];
  document: MerchantKycDocument | undefined;
}) {
  const submit = useSubmitKycDocument();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const status = document?.status;
  // An approved document cannot be replaced from here: the server refuses it,
  // because a merchant who could swap an approved card for something else would
  // keep the activation the real card earned.
  const locked = status === 'approved';

  function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    submit.mutate(
      { file, docType: spec.type },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{spec.label}</span>
          {status ? (
            <Badge
              variant={
                status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : 'warning'
              }
            >
              {status === 'submitted' ? 'being checked' : status}
            </Badge>
          ) : spec.required ? (
            <Badge variant="muted">needed</Badge>
          ) : (
            <Badge variant="muted">optional</Badge>
          )}
        </CardTitle>
        <CardDescription>{spec.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === 'rejected' && document?.rejection_reason ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            Sent back: {document.rejection_reason}
          </p>
        ) : null}
        {document ? (
          <p className="text-xs text-muted-foreground">
            Sent {formatDateTime(document.created_at)}
          </p>
        ) : null}

        {locked ? null : (
          <>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => onPick(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              onClick={() => input.current?.click()}
              disabled={submit.isPending}
            >
              <Upload />
              {submit.isPending
                ? 'Uploading…'
                : status === 'rejected'
                  ? 'Send another'
                  : document
                    ? 'Replace it'
                    : 'Choose a photo'}
            </Button>
          </>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
