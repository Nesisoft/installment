// Money & rate helpers. The backend stores every monetary amount as integer
// pesewas (1 GHS = 100 pesewas) and every rate as basis points (1% = 100 bps).
// These helpers are the single place the frontends convert for display.

export const PESEWAS_PER_GHS = 100;

/** Accepts pesewas as number or numeric string (bigint columns may serialize as string). */
export function pesewasToGhs(pesewas: number | string): number {
  return Number(pesewas) / PESEWAS_PER_GHS;
}

export function ghsToPesewas(ghs: number): number {
  return Math.round(ghs * PESEWAS_PER_GHS);
}

export interface FormatGhsOptions {
  /** Include the ₵ symbol (default true). */
  symbol?: boolean;
  /** Decimal places (default 2). */
  decimals?: number;
}

export function formatGhs(pesewas: number | string, opts: FormatGhsOptions = {}): string {
  const { symbol = true, decimals = 2 } = opts;
  const value = pesewasToGhs(pesewas).toLocaleString('en-GH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return symbol ? `₵${value}` : value;
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}

export function formatBps(bps: number): string {
  const pct = bpsToPercent(bps);
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}
