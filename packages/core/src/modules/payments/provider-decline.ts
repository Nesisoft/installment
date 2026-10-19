/**
 * A charge Paystack declined, recognised from the error the client throws.
 *
 * Captured from Paystack test mode with the repo's own client (2026-10-19), a
 * declined `/charge` does not come back as a 200 with `status: "failed"`. It
 * comes back as **HTTP 400**:
 *
 *   { "status": false, "message": "Charge attempted",
 *     "data": { "reference": "…", "status": "failed", "message": "Declined. …" },
 *     "type": "api_error", "code": "unprocessed_transaction" }
 *
 * The client throws on any non-2xx, so the charge paths treated this as "we
 * don't know whether money moved" and parked the attempt as `unknown`, with
 * the reason "Charge attempted". The verify poll only looks at attempts older
 * than 15 minutes, so a decline Paystack had already reported was recognised
 * 15-20 minutes later.
 *
 * Only a body that says the charge `failed` counts. A 400 that rejects the
 * request itself carries no `data.status`, says nothing about a charge, and is
 * still left to verify.
 */
export interface ProviderDecline {
  /** Paystack's own words: `gateway_response`, else `data.message`. */
  reason: string;
  /** The response body, kept as the attempt's raw response. */
  body: unknown;
}

export function declineFromChargeError(err: unknown): ProviderDecline | null {
  if (!err || typeof err !== 'object') return null;
  const { status, cause } = err as { status?: unknown; cause?: unknown };
  if (status !== 400 || !cause || typeof cause !== 'object') return null;
  const data = (cause as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const d = data as { status?: unknown; gateway_response?: unknown; message?: unknown };
  if (d.status !== 'failed') return null;
  const reason =
    (typeof d.gateway_response === 'string' && d.gateway_response.trim()) ||
    (typeof d.message === 'string' && d.message.trim()) ||
    'charge_failed';
  return { reason, body: cause };
}
