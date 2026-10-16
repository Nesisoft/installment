import { formatBps, type SellerFees } from '@installment/api-types';

export type ParsedOverride = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * A negotiated-rate field as typed.
 *
 * Blank is an answer, not a missing one: no deal, so each plan charges its own
 * business model's rate. It is sent as NULL — which is also how a deal ends —
 * and never as 0, which is a real (and generous) rate. The old field ran
 * `Number('')` and stored exactly that.
 */
export function parseBpsOverride(input: string, max: number): ParsedOverride {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > max) {
    return {
      ok: false,
      message: `Enter whole basis points from 0 to ${max} (250 is 2.5%), or leave it blank for the plan rate.`,
    };
  }
  return { ok: true, value: Number(trimmed) };
}

/**
 * What a merchant is charged on a plan, as the console prints it — from
 * `fees`, which the API computes with the code that charges it.
 */
export function describeRates(fees: SellerFees, which: 'mdr' | 'reserve'): string {
  const values = Object.values(fees.plans).map((p) =>
    which === 'mdr' ? p.mdr_bps : p.reserve_bps,
  );
  const negotiated = which === 'mdr' ? fees.mdr_negotiated : fees.reserve_negotiated;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (negotiated) return `${formatBps(lo)} (negotiated)`;
  return lo === hi
    ? `${formatBps(lo)} on every plan type`
    : `${formatBps(lo)}–${formatBps(hi)} by plan type`;
}
