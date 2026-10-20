/**
 * Paystack declining to create a refund, recognised from the error the client
 * throws. Every case below is an HTTP 400, captured from Paystack test mode
 * (2026-10-20):
 *
 *   { status: false, message: "Refund amount exceeds transaction amount",
 *     type: "validation_error", code: "refund_amount_exceeds_transaction_amount" }
 *   { status: false, message: "Transaction not found",
 *     type: "validation_error", code: "transaction_not_found" }
 *   { status: false, message: "A refund already exist for this transaction",
 *     type: "api_error", code: "transaction_reversed",
 *     data: { existing_refunds: [{ id, amount, status, … }] } }
 *
 * `disburse` used to treat each as "the call may or may not have reached
 * Paystack" and park the refund `unknown` with no provider id — which the
 * reconciler cannot verify, so it waited for a person indefinitely. A
 * validation refusal means no refund was created; "already exists" names the
 * one that was.
 */
export interface ProviderRefundRef {
  id: string;
  amount?: number;
  status?: string;
}

export type RefundRejection =
  | { kind: 'refused'; message: string }
  | { kind: 'exists'; message: string; existing: ProviderRefundRef[] };

export function refundRejection(err: unknown): RefundRejection | null {
  if (!err || typeof err !== 'object') return null;
  const { status, cause } = err as { status?: unknown; cause?: unknown };
  if (status !== 400 || !cause || typeof cause !== 'object') return null;
  const body = cause as {
    status?: unknown;
    message?: unknown;
    type?: unknown;
    code?: unknown;
    data?: unknown;
  };
  if (body.status !== false) return null;
  const message =
    typeof body.message === 'string' ? body.message : 'refused by the payment provider';

  const existing = (body.data as { existing_refunds?: unknown } | undefined)?.existing_refunds;
  if (body.code === 'transaction_reversed' && Array.isArray(existing)) {
    return { kind: 'exists', message, existing: existing.map(toRef).filter((r) => r !== null) };
  }
  if (body.type === 'validation_error') return { kind: 'refused', message };
  return null;
}

/** One entry of Paystack's refund list, as far as matching needs it. */
export function toRef(raw: unknown): ProviderRefundRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { id?: unknown; amount?: unknown; status?: unknown };
  if (typeof r.id !== 'number' && typeof r.id !== 'string') return null;
  return {
    id: String(r.id),
    ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
  };
}
